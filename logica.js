import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  arrayUnion,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

console.log("logica.js v3 cargado ✅");

const $ = (id) => document.getElementById(id);
const UMBRAL_MS = 60_000;

let yo = null; // { id, nombre }
let usuarios = [];
let misConvs = [];
let salas = [];
let convActiva = null; // id de la conversación abierta
let cancelarMensajes = null;

// ===== 1. INGRESAR / REGISTRAR =====
let modo = "ingresar";

function cambiarModo(m) {
  modo = m;
  $("inputNombre").classList.toggle("oculto", m === "ingresar");
  $("btnAccion").textContent = m === "ingresar" ? "Ingresar" : "Registrar";
  $("tabIngresar").classList.toggle("activa", m === "ingresar");
  $("tabRegistrar").classList.toggle("activa", m === "registrar");
  $("msgError").textContent = "";
}

$("tabIngresar").onclick = () => cambiarModo("ingresar");
$("tabRegistrar").onclick = () => cambiarModo("registrar");

$("btnAccion").onclick = async () => {
  const id = $("inputId").value.trim();
  const nombre = $("inputNombre").value.trim();
  const error = (t) => ($("msgError").textContent = t);
  if (!id) return error("Escribe tu identificador.");
  try {
    const ref = doc(db, "usuarios", id);
    const snap = await getDoc(ref);

    if (modo === "registrar") {
      if (!nombre) return error("Escribe tu nombre visible.");
      if (snap.exists()) return error("Ese identificador ya existe. Usa Ingresar.");
      await setDoc(ref, {
        nombre,
        estado: "online",
        lastSeen: serverTimestamp(),
        creadoEn: serverTimestamp(),
      });
      entrar(id, nombre);
    } else {
      if (!snap.exists()) return error("No existe. Regístrate primero.");
      entrar(id, snap.data().nombre);
    }
  } catch (e) {
    error("Error: " + (e.code || e.message));
  }
};

async function entrar(id, nombre) {
  yo = { id, nombre };
  await setDoc(
    doc(db, "usuarios", id),
    { estado: "online", lastSeen: serverTimestamp() },
    { merge: true },
  );
  $("yo").textContent = `Tú: ${nombre} (${id})`;
  $("login").classList.add("oculto");
  $("app").classList.remove("oculto");
  escucharUsuarios();
  escucharConversaciones();
  iniciarPresencia();
}

$("btnSalir").onclick = async () => {
  await setDoc(
    doc(db, "usuarios", yo.id),
    { estado: "offline", lastSeen: serverTimestamp() },
    { merge: true },
  );
  location.reload();
};

// ===== 2. LISTAS EN TIEMPO REAL =====
function escucharUsuarios() {
  onSnapshot(collection(db, "usuarios"), (snap) => {
    usuarios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    pintarUsuarios();
    pintarConversaciones();
  }, (e) => alert("Error leyendo usuarios: " + e.code));
}

function escucharConversaciones() {
  const col = collection(db, "conversaciones");

  // Chats donde participo (privados y grupos): aparecen solos al recibir uno nuevo
  onSnapshot(
    query(col, where("participantes", "array-contains", yo.id)),
    (snap) => {
      misConvs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const ms = (c) =>
        c.actualizadaEn ? c.actualizadaEn.toMillis() : Date.now();
      misConvs.sort((a, b) => ms(b) - ms(a));
      pintarConversaciones();
      pintarSalas();
    },
    (e) => alert("Error leyendo conversaciones: " + e.code),
  );

  // Todas las salas, para poder unirme
  onSnapshot(
    query(col, where("tipo", "==", "grupo")),
    (snap) => {
      salas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      pintarSalas();
    },
    (e) => alert("Error leyendo salas: " + e.code),
  );
}

function disponible(u) {
  return u.estado === "online" && u.lastSeen && Date.now() - u.lastSeen.toMillis() < UMBRAL_MS;
}

function nombreDe(id) {
  return usuarios.find((u) => u.id === id)?.nombre || id;
}

function tituloDe(c) {
  if (c.tipo === "grupo") return "👥 " + c.nombre;
  return nombreDe(c.participantes.find((p) => p !== yo.id));
}

function pintarUsuarios() {
  const ul = $("listaUsuarios");
  ul.innerHTML = "";
  usuarios.filter((u) => u.id !== yo.id).forEach((u) => {
    const li = document.createElement("li");
    const punto = document.createElement("span");
    punto.className = "punto" + (disponible(u) ? " online" : "");
    const txt = document.createElement("span");
    txt.textContent = `${u.nombre} (${u.id})`;
    li.append(punto, txt);
    li.onclick = () => abrirPrivada(u);
    ul.appendChild(li);
  });
}

function pintarLista(ulId, items, etiqueta, alClic) {
  const ul = $(ulId);
  ul.innerHTML = "";
  items.forEach((it) => {
    const li = document.createElement("li");
    li.textContent = etiqueta(it);
    if (it.id === convActiva) li.classList.add("activo");
    li.onclick = () => alClic(it);
    ul.appendChild(li);
  });
}

function pintarConversaciones() {
  pintarLista("listaConversaciones", misConvs, tituloDe, abrirConversacion);
  const c = misConvs.find((x) => x.id === convActiva);
  if (c) cabecera(c);
}

function pintarSalas() {
  const libres = salas.filter((s) => !s.participantes.includes(yo.id));
  pintarLista("listaSalas", libres, (s) => `${s.nombre} (unirme)`, unirse);
}

function cabecera(c) {
  $("tituloChat").textContent = tituloDe(c);
  $("participantes").textContent = "Participantes: " + c.participantes.map(nombreDe).join(", ");
}

// ===== 3. ABRIR / CREAR CONVERSACIONES =====
async function abrirPrivada(u) {
  try {
    const ids = [yo.id, u.id].sort();
    const id = ids.join("_"); // ID determinista: no se duplica
    const ref = doc(db, "conversaciones", id);

    if (!(await getDoc(ref)).exists()) {
      await setDoc(ref, {
        tipo: "privada",
        participantes: ids,
        creadaEn: serverTimestamp(),
        actualizadaEn: serverTimestamp(),
      });
    }
    abrirConversacion({ id, tipo: "privada", participantes: ids });
  } catch (e) {
    alert("No se pudo abrir el chat: " + (e.code || e.message));
  }
}

$("btnNuevaSala").onclick = async () => {
  const nombre = (prompt("Nombre de la sala:") || "").trim();
  if (!nombre) return;

  try {
    const ref = await addDoc(collection(db, "conversaciones"), {
      tipo: "grupo",
      nombre,
      participantes: [yo.id],
      creadaPor: yo.id,
      creadaEn: serverTimestamp(),
      actualizadaEn: serverTimestamp(),
    });
    abrirConversacion({
      id: ref.id,
      tipo: "grupo",
      nombre,
      participantes: [yo.id],
    });
  } catch (e) {
    alert("No se pudo crear la sala: " + (e.code || e.message));
  }
}

async function unirse(sala) {
  try {
    await updateDoc(doc(db, "conversaciones", sala.id), {
      participantes: arrayUnion(yo.id),
    });
    abrirConversacion({ ...sala, participantes: [...sala.participantes, yo.id] });
  } catch (e) {
    alert("No se pudo unir: " + (e.code || e.message));
  }
}

function abrirConversacion(c) {
  convActiva = c.id;
  cabecera(c);
  pintarConversaciones();
  escucharMensajes();
}

// ===== 4. MENSAJES =====
function escucharMensajes() {
  if (cancelarMensajes) cancelarMensajes(); // no mezclar chats al cambiar
  $("mensajes").innerHTML = "";
  $("inputMensaje").disabled = false;
  $("btnEnviar").disabled = false;

  const q = query(
    collection(db, "conversaciones", convActiva, "mensajes"),
    orderBy("creadoEn", "asc"),
  );
  cancelarMensajes = onSnapshot(
    q,
    (snap) => {
      const cont = $("mensajes");
      cont.innerHTML = "";
      snap.docs.forEach((d) => {
        const m = d.data();
        const propio = m.emisorId === yo.id;
        const div = document.createElement("div");
        div.className = "msg" + (propio ? " propio" : "");
        const quien = document.createElement("small");
        quien.textContent = propio ? "Tú" : m.emisorNombre;
        const txt = document.createElement("span");
        txt.textContent = m.texto;
        div.append(quien, txt);
        cont.appendChild(div);
      });
      cont.scrollTop = cont.scrollHeight;
    },
    (e) => alert("Error leyendo mensajes: " + e.code),
  );
}

async function enviar() {
  const texto = $("inputMensaje").value.trim();
  if (!texto) return alert("No puedes enviar un mensaje vacío.");
  if (!convActiva) return;
  $("inputMensaje").value = "";

  try {
    await addDoc(collection(db, "conversaciones", convActiva, "mensajes"), {
      emisorId: yo.id,
      emisorNombre: yo.nombre,
      texto,
      creadoEn: serverTimestamp(),
    });
    await updateDoc(doc(db, "conversaciones", convActiva), {
      ultimoMensaje: texto,
      actualizadaEn: serverTimestamp(),
    });
  } catch (e) {
    alert("No se pudo enviar: " + (e.code || e.message));
  }
}

$("btnEnviar").onclick = enviar;
$("inputMensaje").addEventListener(
  "keydown",
  (e) => e.key === "Enter" && enviar(),
);

// ===== 5. PRESENCIA =====
function iniciarPresencia() {
  setInterval(() => {
    setDoc(
      doc(db, "usuarios", yo.id),
      { estado: "online", lastSeen: serverTimestamp() },
      { merge: true },
    );
  }, 30_000);

  window.addEventListener("beforeunload", () => {
    setDoc(
      doc(db, "usuarios", yo.id),
      { estado: "offline", lastSeen: serverTimestamp() },
      { merge: true },
    );
  });
}