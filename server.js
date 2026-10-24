"use strict";
/* server.js · arranca la API: conecta con MongoDB y escucha peticiones.
   Variables de entorno (en Render: pestaña "Environment"):
     MONGODB_URI           cadena de conexión de MongoDB Atlas (obligatoria)
     SECRETO_TOKEN         texto largo y aleatorio, mínimo 16 caracteres (obligatoria)
     ORIGENES_PERMITIDOS   webs que pueden usar la API, separadas por comas, sin "/" final
                           ej.: https://tuusuario.github.io   (vacío = cualquiera)
     PORT                  lo pone Render solo                                          */
const { MongoClient } = require("mongodb");
const { crearApp } = require("./app");

const uri = process.env.MONGODB_URI;
const secreto = process.env.SECRETO_TOKEN;
if (!uri || !secreto) {
  console.error("Faltan las variables de entorno MONGODB_URI y/o SECRETO_TOKEN");
  process.exit(1);
}
const origenes = (process.env.ORIGENES_PERMITIDOS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const puerto = Number(process.env.PORT) || 3000;

async function main() {
  const cliente = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await cliente.connect();
  const coleccion = cliente.db("via_al_cielo").collection("ranking");
  await coleccion.createIndex({ p: -1, t: 1 });
  const servidor = crearApp({ coleccion, secreto, origenes });
  servidor.listen(puerto, "0.0.0.0", () => {
    console.log("API del ranking escuchando en el puerto " + puerto);
    if (origenes.length === 0) console.warn("Aviso: ORIGENES_PERMITIDOS vacío → cualquier web puede usar la API");
  });
}
main().catch((e) => { console.error("No se pudo arrancar:", e.message); process.exit(1); });
