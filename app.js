"use strict";
/* ============================================================================
   app.js · API del ranking de "Vía al Cielo"
   - Solo usa módulos de Node (http, crypto). La única dependencia del proyecto es "mongodb".
   - Rutas:
       GET  /api/ranking  → top 10 [{ n, p, s, t }]
       GET  /api/inicio   → token de partida (el juego lo pide al empezar a jugar)
       POST /api/ranking  → guarda { n, p, s, tk } si pasa todas las validaciones
   ============================================================================ */
const http = require("http");
const crypto = require("crypto");

const RE_NOMBRE = /^[A-Z0-9]{3,6}$/;     // iniciales: 3 a 6 caracteres A-Z / 0-9
const METROS_POR_PANTALLA = 220;         // igual que METROS_FIN_PANTALLA del juego
const PUNTOS_MAX = 100000;
const TAM_RANKING = 10;
const VEL_MAX_M_S = 14;                  // metros por segundo máximos creíbles al jugar
const HOLGURA_M = 300;                   // margen (arranques en frío de Render, etc.)
const TOKEN_VIDA_MS = 6 * 60 * 60 * 1000;
const ESPERA_ENTRE_ENVIOS_MS = 20 * 1000;
const MAX_ENVIOS_POR_HORA = 10;
const MAX_CUERPO = 2048;

function crearApp({ coleccion, secreto, origenes = [], ahora = () => Date.now() }) {
  if (!secreto || secreto.length < 16) throw new Error("SECRETO_TOKEN debe tener al menos 16 caracteres");
  const tokensUsados = new Map();   // nonce → caducidad
  const envios = new Map();         // ip → [instantes de los últimos intentos]

  // ---------- Tokens firmados (sin base de datos) ----------
  function firmar(texto) { return crypto.createHmac("sha256", secreto).update(texto).digest("base64url"); }
  function nuevoToken() {
    const nonce = crypto.randomBytes(9).toString("base64url");
    const base = nonce + "." + ahora();
    return base + "." + firmar(base);
  }
  function leerToken(tk) {
    if (typeof tk !== "string" || tk.length > 120) return null;
    const partes = tk.split(".");
    if (partes.length !== 3) return null;
    const esperada = Buffer.from(firmar(partes[0] + "." + partes[1]));
    const recibida = Buffer.from(partes[2]);
    if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return null;
    const ts = Number(partes[1]);
    return Number.isFinite(ts) ? { nonce: partes[0], ts } : null;
  }

  // ---------- Limpieza de memoria ----------
  function limpiar() {
    const t = ahora();
    for (const [k, caduca] of tokensUsados) if (caduca < t) tokensUsados.delete(k);
    for (const [ip, lista] of envios) {
      const vivos = lista.filter((x) => t - x < 3600e3);
      if (vivos.length) envios.set(ip, vivos); else envios.delete(ip);
    }
  }

  // ---------- Límite de envíos por IP ----------
  function ipDe(req) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
    return req.socket.remoteAddress || "?";
  }
  function anotarSiPuede(ip) {
    const t = ahora();
    const lista = (envios.get(ip) || []).filter((x) => t - x < 3600e3);
    const bloqueado = lista.length >= MAX_ENVIOS_POR_HORA || (lista.length > 0 && t - lista[lista.length - 1] < ESPERA_ENTRE_ENVIOS_MS);
    if (!bloqueado) { lista.push(t); }
    envios.set(ip, lista);
    return !bloqueado;
  }

  // ---------- Utilidades HTTP ----------
  function cabecerasCors(req) {
    const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
    const origen = req.headers.origin;
    if (origenes.length === 0) h["Access-Control-Allow-Origin"] = "*";
    else if (origen && origenes.includes(origen)) h["Access-Control-Allow-Origin"] = origen;
    return h;
  }
  function responder(req, res, estado, cuerpo) {
    res.writeHead(estado, Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }, cabecerasCors(req)));
    res.end(cuerpo === undefined ? "" : JSON.stringify(cuerpo));
  }
  function leerCuerpo(req) {
    return new Promise((ok, mal) => {
      const trozos = []; let tam = 0, grande = false;
      req.on("data", (c) => { tam += c.length; if (tam > MAX_CUERPO) grande = true; else trozos.push(c); });
      req.on("end", () => (grande ? mal(Object.assign(new Error("cuerpo grande"), { grande: true })) : ok(Buffer.concat(trozos).toString("utf8"))));
      req.on("error", mal);
    });
  }

  async function topRanking() {
    const docs = await coleccion.find({}, { projection: { _id: 0, n: 1, p: 1, s: 1, t: 1 } })
      .sort({ p: -1, t: 1 }).limit(TAM_RANKING).toArray();
    return docs.map((d) => ({ n: d.n, p: d.p, s: d.s, t: d.t instanceof Date ? d.t.getTime() : Number(d.t) || 0 }));
  }

  async function guardarPuntuacion(req, res) {
    if (!anotarSiPuede(ipDe(req))) return responder(req, res, 429, { error: "demasiados_envios" });
    let datos;
    try { datos = JSON.parse(await leerCuerpo(req)); }
    catch (e) { return responder(req, res, e.grande ? 413 : 400, { error: e.grande ? "cuerpo_grande" : "json_invalido" }); }
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) return responder(req, res, 400, { error: "json_invalido" });

    const n = typeof datos.n === "string" ? datos.n.trim().toUpperCase() : "";
    const p = datos.p, s = datos.s;
    if (!RE_NOMBRE.test(n)) return responder(req, res, 400, { error: "nombre_invalido" });
    if (!Number.isInteger(p) || p < 1 || p > PUNTOS_MAX) return responder(req, res, 400, { error: "puntos_invalidos" });
    if (!Number.isInteger(s) || s < 1 || s > 99) return responder(req, res, 400, { error: "pantalla_invalida" });
    // Los metros totales tienen que cuadrar con la pantalla alcanzada (con un margen de una pantalla)
    if (p < (s - 2) * METROS_POR_PANTALLA || p > s * METROS_POR_PANTALLA) return responder(req, res, 400, { error: "incoherente" });

    const tk = leerToken(datos.tk);
    if (!tk) return responder(req, res, 400, { error: "token_invalido" });
    const t = ahora();
    if (t - tk.ts > TOKEN_VIDA_MS || tk.ts > t + 1000) return responder(req, res, 400, { error: "token_caducado" });
    if (tokensUsados.has(tk.nonce)) return responder(req, res, 400, { error: "token_usado" });
    // No se puede subir más rápido de lo que permite el juego desde que empezó la partida
    if (p > VEL_MAX_M_S * ((t - tk.ts) / 1000) + HOLGURA_M) return responder(req, res, 400, { error: "puntuacion_imposible" });

    tokensUsados.set(tk.nonce, tk.ts + TOKEN_VIDA_MS);
    await coleccion.insertOne({ n, p, s, t: new Date(t) });
    return responder(req, res, 200, { ok: true, ranking: await topRanking() });
  }

  return http.createServer(async (req, res) => {
    try {
      const ruta = (req.url || "/").split("?")[0];
      const origen = req.headers.origin;
      if (req.method === "OPTIONS") return responder(req, res, 204);
      if (origen && origenes.length && !origenes.includes(origen)) return responder(req, res, 403, { error: "origen_no_permitido" });
      limpiar();

      if (ruta === "/" || ruta === "/salud") return responder(req, res, 200, { ok: true, servicio: "via-al-cielo-api" });
      if (ruta === "/api/ranking" && req.method === "GET") return responder(req, res, 200, await topRanking());
      if (ruta === "/api/inicio" && req.method === "GET") return responder(req, res, 200, { token: nuevoToken() });
      if (ruta === "/api/ranking" && req.method === "POST") return await guardarPuntuacion(req, res);
      if (ruta === "/api/ranking" || ruta === "/api/inicio") return responder(req, res, 405, { error: "metodo_no_permitido" });
      return responder(req, res, 404, { error: "no_encontrado" });
    } catch (e) {
      console.error("Error en la petición:", e);
      if (!res.headersSent) responder(req, res, 500, { error: "error_interno" });
    }
  });
}

module.exports = { crearApp };
