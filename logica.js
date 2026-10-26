import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  arrayUnion,
  arrayRemove,
  runTransaction,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

console.log("logica.js v4 cargado ✅");

const $ = (id) => document.getElementById(id);
const UMBRAL_MS = 60_000; // sin latido en 60 s => desconectado
const LATIDO_MS = 30_000; // cada 30 s se actualiza lastSeen
const ID_VALIDO = /^[A-Z0-9-]{2,20}$/; // sin "_" porque se usa para unir IDs de chats privados

let yo = null; // { id, nombre }
let usuarios = [];
let misConvs = [];
let salas = [];
let convActiva = null; // id de la conversación abierta
let cancelarMensajes = null;
let suscripciones = []; // listeners globales, se cancelan al salir
let latido = null;
const leidoHasta = {}; // convId -> ms del último mensaje visto (para marcar "nuevo")

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

// Los IDs de documento distinguen mayúsculas ("u023" != "U023"), así que los
// nuevos se guardan en mayúsculas. Primero se busca el ID tal cual (para no
// dejar por fuera usuarios antiguos en minúsculas) y luego normalizado; así
// tampoco se puede registrar el "gemelo" de un ID que ya existe.
async function buscarUsuario(texto) {
  const exacto = await getDoc(doc(db, "usuarios", texto));
  const normal = texto.toUpperCase();
  if (exacto.exists() || normal === texto) return exacto;
  return getDoc(doc(db, "usuarios", normal));
}

$("btnAccion").onclick = async () => {
  const texto = $("inputId").value.trim();
  const nombre = $("inputNombre").value.trim();
  const error = (t) => ($("msgError").textContent = t);
  if (!texto) return error("Escribe tu identificador.");
  if (!ID_VALIDO.test(texto.toUpperCase()))
    return error("El identificador solo puede tener letras, números y guiones (2 a 20).");

  try {
    const snap = await buscarUsuario(texto);

    if (modo === "registrar") {
      if (!nombre) return error("Escribe tu nombre visible.");
      if (nombre.length > 40) return error("El nombre visible es muy largo.");
      if (snap.exists()) return error(`El identificador ${snap.id} ya existe. Usa Ingresar.`);
      const id = texto.toUpperCase();
      // La transacción evita que dos personas registren el mismo ID a la vez
      await runTransaction(db, async (tx) => {
        const ref = doc(db, "usuarios", id);
        if ((await tx.get(ref)).exists()) throw new Error("Ese identificador acaba de ser tomado.");
        tx.set(ref, {
          nombre,
          estado: "online",
          lastSeen: serverTimestamp(),
          creadoEn: serverTimestamp(),
        });
      });
      entrar(id, nombre);
    } else {
      if (!snap.exists()) return error("No existe. Regístrate primero.");
      entrar(snap.id, snap.data().nombre || snap.id);
    }
  } catch (e) {
    error("Error: " + (e.code || e.message));
  }
};

$("inputId").addEventListener("keydown", (e) => e.key === "Enter" && $("btnAccion").click());
$("inputNombre").addEventListener("keydown", (e) => e.key === "Enter" && $("btnAccion").click());

async function entrar(id, nombre) {
  yo = { id, nombre };
  await marcarEstado("online");
  $("yo").textContent = nombre;
  $("yoId").textContent = id;
  $("avatarYo").textContent = inicial(nombre);
  $("login").classList.add("oculto");
  $("app").classList.remove("oculto");
  escucharUsuarios();
  escucharConversaciones();
  iniciarPresencia();
}

$("btnSalir").onclick = async () => {
  suscripciones.forEach((cancelar) => cancelar());
  if (cancelarMensajes) cancelarMensajes();
  clearInterval(latido);
  await marcarEstado("offline");
  location.reload();
};

// ===== 2. LISTAS EN TIEMPO REAL =====
function escucharUsuarios() {
  suscripciones.push(
    onSnapshot(
      collection(db, "usuarios"),
      (snap) => {
        usuarios = snap.docs.map((d) => ({
          id: d.id,
          ...d.data({ serverTimestamps: "estimate" }),
        }));
        pintarUsuarios();
        pintarConversaciones();
      },
      (e) => alert("Error leyendo usuarios: " + e.code),
    ),
  );
}

function escucharConversaciones() {
  const col = collection(db, "conversaciones");
  let primeraCarga = true;

  // Chats donde participo (privados y grupos): aparecen solos al recibir uno nuevo
  suscripciones.push(
    onSnapshot(
      query(col, where("participantes", "array-contains", yo.id)),
      (snap) => {
        misConvs = snap.docs.map((d) => ({
          id: d.id,
          ...d.data({ serverTimestamps: "estimate" }),
        }));
        misConvs.sort((a, b) => msDe(b.actualizadaEn) - msDe(a.actualizadaEn));
        // Lo que ya había al entrar no cuenta como "nuevo"
        if (primeraCarga) misConvs.forEach((c) => (leidoHasta[c.id] = msDe(c.actualizadaEn)));
        primeraCarga = false;
        pintarConversaciones();
        pintarSalas();
      },
      (e) => alert("Error leyendo conversaciones: " + e.code),
    ),
  );

  // Todas las salas, para poder unirme
  suscripciones.push(
    onSnapshot(
      query(col, where("tipo", "==", "grupo")),
      (snap) => {
        salas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        pintarSalas();
      },
      (e) => alert("Error leyendo salas: " + e.code),
    ),
  );
}

function msDe(ts) {
  return ts ? ts.toMillis() : Date.now();
}

function disponible(u) {
  return u.estado === "online" && u.lastSeen && Date.now() - u.lastSeen.toMillis() < UMBRAL_MS;
}

function nombreDe(id) {
  return usuarios.find((u) => u.id === id)?.nombre || id;
}

function inicial(nombre) {
  return (nombre || "?").trim().charAt(0).toUpperCase() || "?";
}

function tituloDe(c) {
  if (c.tipo === "grupo") return "👥 " + c.nombre;
  return nombreDe(c.participantes.find((p) => p !== yo.id));
}

function haceCuanto(u) {
  if (!u.lastSeen) return "nunca conectado";
  if (disponible(u)) return "en línea";
  const min = Math.round((Date.now() - u.lastSeen.toMillis()) / 60_000);
  if (min < 60) return `visto hace ${min} min`;
  if (min < 1440) return `visto hace ${Math.round(min / 60)} h`;
  return "visto " + u.lastSeen.toDate().toLocaleDateString();
}

function pintarUsuarios() {
  const filtro = $("buscarUsuario").value.trim().toLowerCase();
  const ul = $("listaUsuarios");
  ul.innerHTML = "";
  usuarios
    .filter((u) => u.id !== yo.id)
    .filter((u) => !filtro || `${u.nombre} ${u.id}`.toLowerCase().includes(filtro))
    // Primero los disponibles, luego por nombre
    .sort((a, b) => disponible(b) - disponible(a) || (a.nombre || a.id).localeCompare(b.nombre || b.id))
    .forEach((u) => {
      const li = document.createElement("li");
      const punto = document.createElement("span");
      punto.className = "punto" + (disponible(u) ? " online" : "");
      const txt = document.createElement("div");
      txt.className = "texto";
      const nombre = document.createElement("span");
      nombre.textContent = `${u.nombre || "(sin nombre)"} (${u.id})`;
      const estado = document.createElement("small");
      estado.textContent = haceCuanto(u);
      txt.append(nombre, estado);
      li.append(punto, txt);
      li.onclick = () => abrirPrivada(u);
      ul.appendChild(li);
    });
}

$("buscarUsuario").addEventListener("input", pintarUsuarios);

function pintarConversaciones() {
  const ul = $("listaConversaciones");
  ul.innerHTML = "";
  if (!misConvs.length) ul.innerHTML = '<li class="vacio">Aún no tienes conversaciones</li>';
  misConvs.forEach((c) => {
    const li = document.createElement("li");
    if (c.id === convActiva) li.classList.add("activo");
    const txt = document.createElement("div");
    txt.className = "texto";
    const titulo = document.createElement("span");
    titulo.textContent = tituloDe(c);
    const ultimo = document.createElement("small");
    ultimo.textContent = c.ultimoMensaje
      ? (c.ultimoEmisorId === yo.id ? "Tú: " : "") + c.ultimoMensaje
      : "Sin mensajes";
    txt.append(titulo, ultimo);
    li.append(txt);
    if (tieneNuevos(c)) {
      li.classList.add("nuevo");
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "nuevo";
      li.append(badge);
    }
    li.onclick = () => abrirConversacion(c);
    ul.appendChild(li);
  });
  const c = misConvs.find((x) => x.id === convActiva);
  if (c) cabecera(c);
}

// Un chat tiene mensajes nuevos si el último no es mío y llegó después de la
// última vez que lo vi en esta sesión (o nunca lo he abierto en esta sesión).
function tieneNuevos(c) {
  if (c.id === convActiva || !c.ultimoMensaje || c.ultimoEmisorId === yo.id) return false;
  return msDe(c.actualizadaEn) > (leidoHasta[c.id] ?? 0);
}

function pintarSalas() {
  const ul = $("listaSalas");
  ul.innerHTML = "";
  const libres = salas.filter((s) => !s.participantes.includes(yo.id));
  if (!libres.length) ul.innerHTML = '<li class="vacio">No hay salas nuevas</li>';
  libres.forEach((s) => {
    const li = document.createElement("li");
    const txt = document.createElement("div");
    txt.className = "texto";
    const nombre = document.createElement("span");
    nombre.textContent = "👥 " + s.nombre;
    const info = document.createElement("small");
    info.textContent = `${s.participantes.length} participante(s) · clic para unirte`;
    txt.append(nombre, info);
    li.append(txt);
    li.onclick = () => unirse(s);
    ul.appendChild(li);
  });
}

function cabecera(c) {
  $("tituloChat").textContent = tituloDe(c);
  if (c.tipo === "grupo") {
    $("participantes").textContent = "Participantes: " + c.participantes.map(nombreDe).join(", ");
  } else {
    const otro = usuarios.find((u) => u.id === c.participantes.find((p) => p !== yo.id));
    $("participantes").textContent = otro ? `${otro.id} · ${haceCuanto(otro)}` : "";
  }
  $("btnSalirSala").classList.toggle("oculto", c.tipo !== "grupo");
}

// ===== 3. ABRIR / CREAR CONVERSACIONES =====
// Chat privado: ID determinista con los dos IDs ordenados ("U001_U002").
// La transacción garantiza que si ambos usuarios lo abren al mismo tiempo,
// solo uno lo crea; el otro ve que ya existe y lo reutiliza.
async function abrirPrivada(u) {
  try {
    const ids = [yo.id, u.id].sort();
    const id = ids.join("_");
    const ref = doc(db, "conversaciones", id);

    await runTransaction(db, async (tx) => {
      if (!(await tx.get(ref)).exists()) {
        tx.set(ref, {
          tipo: "privada",
          participantes: ids,
          creadaEn: serverTimestamp(),
          actualizadaEn: serverTimestamp(),
        });
      }
    });
    abrirConversacion({ id, tipo: "privada", participantes: ids });
  } catch (e) {
    alert("No se pudo abrir el chat: " + (e.code || e.message));
  }
}

// Sala: el ID sale del nombre normalizado ("Bases de Datos" -> "sala-bases-de-datos"),
// así no se crean dos salas con el mismo nombre.
function idDeSala(nombre) {
  const slug = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? "sala-" + slug : null;
}

async function crearSala() {
  const nombre = $("inputSala").value.trim();
  const error = (t) => ($("msgSala").textContent = t);
  error("");
  if (!nombre) return error("Escribe el nombre de la sala.");
  if (nombre.length > 40) return error("Máximo 40 caracteres.");
  const id = idDeSala(nombre);
  if (!id) return error("El nombre debe tener letras o números.");

  try {
    const ref = doc(db, "conversaciones", id);
    await runTransaction(db, async (tx) => {
      if ((await tx.get(ref)).exists()) throw new Error("Ya existe una sala con ese nombre.");
      tx.set(ref, {
        tipo: "grupo",
        nombre,
        participantes: [yo.id],
        creadaPor: yo.id,
        creadaEn: serverTimestamp(),
        actualizadaEn: serverTimestamp(),
      });
    });
    $("inputSala").value = "";
    abrirConversacion({ id, tipo: "grupo", nombre, participantes: [yo.id] });
  } catch (e) {
    error(e.code || e.message);
  }
}

$("btnNuevaSala").onclick = crearSala;
$("inputSala").addEventListener("keydown", (e) => e.key === "Enter" && crearSala());

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

$("btnSalirSala").onclick = async () => {
  const c = misConvs.find((x) => x.id === convActiva);
  if (!c || c.tipo !== "grupo") return;
  if (!confirm(`¿Salir de la sala "${c.nombre}"?`)) return;
  try {
    await updateDoc(doc(db, "conversaciones", c.id), {
      participantes: arrayRemove(yo.id),
    });
    cerrarConversacion();
  } catch (e) {
    alert("No se pudo salir: " + (e.code || e.message));
  }
};

function abrirConversacion(c) {
  convActiva = c.id;
  leidoHasta[c.id] = Date.now();
  cabecera(c);
  pintarConversaciones();
  escucharMensajes();
}

function cerrarConversacion() {
  if (cancelarMensajes) cancelarMensajes();
  cancelarMensajes = null;
  convActiva = null;
  $("tituloChat").textContent = "Selecciona un chat";
  $("participantes").textContent = "";
  $("btnSalirSala").classList.add("oculto");
  $("mensajes").innerHTML = "";
  $("inputMensaje").disabled = true;
  $("btnEnviar").disabled = true;
  pintarConversaciones();
}

// ===== 4. MENSAJES =====
function horaDe(ts) {
  const f = ts.toDate();
  const hora = f.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return f.toDateString() === new Date().toDateString()
    ? hora
    : `${f.toLocaleDateString()} ${hora}`;
}

function crearBurbuja(id, m, pendiente) {
  const propio = m.emisorId === yo.id;
  const div = document.createElement("div");
  div.className = "msg" + (propio ? " propio" : "");
  div.dataset.id = id;
  const quien = document.createElement("small");
  quien.className = "quien";
  quien.textContent = propio ? "Tú" : m.emisorNombre || nombreDe(m.emisorId);
  const txt = document.createElement("span");
  txt.textContent = m.texto;
  const hora = document.createElement("small");
  hora.className = "hora";
  // Mientras el servidor no confirma, creadoEn es una estimación local
  hora.textContent = (m.creadoEn ? horaDe(m.creadoEn) : "") + (pendiente ? " · enviando…" : "");
  div.append(quien, txt, hora);
  return div;
}

// Se procesan solo los cambios (docChanges) en vez de volver a pintar todo
// el historial en cada actualización.
function escucharMensajes() {
  if (cancelarMensajes) cancelarMensajes(); // no mezclar chats al cambiar
  const cont = $("mensajes");
  cont.innerHTML = '<p class="vacio">Cargando mensajes…</p>';
  $("inputMensaje").disabled = false;
  $("btnEnviar").disabled = false;
  $("inputMensaje").focus();

  const id = convActiva;
  const q = query(
    collection(db, "conversaciones", id, "mensajes"),
    orderBy("creadoEn", "asc"),
  );
  cancelarMensajes = onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      if (id !== convActiva) return;
      if (cont.querySelector(".vacio")) cont.innerHTML = "";
      const abajo = cont.scrollHeight - cont.scrollTop - cont.clientHeight < 60;

      snap.docChanges().forEach((ch) => {
        const viejo = cont.querySelector(`[data-id="${ch.doc.id}"]`);
        if (ch.type === "removed") return viejo?.remove();
        const nuevo = crearBurbuja(
          ch.doc.id,
          ch.doc.data({ serverTimestamps: "estimate" }),
          ch.doc.metadata.hasPendingWrites,
        );
        if (viejo) viejo.remove();
        cont.insertBefore(nuevo, cont.children[ch.newIndex] || null);
      });

      if (!snap.size) cont.innerHTML = '<p class="vacio">No hay mensajes. ¡Escribe el primero!</p>';
      leidoHasta[id] = Date.now();
      // Solo bajar si ya estaba abajo o si el último mensaje es mío
      const ultimo = snap.docs[snap.size - 1]?.data();
      if (abajo || ultimo?.emisorId === yo.id) cont.scrollTop = cont.scrollHeight;
    },
    (e) => alert("Error leyendo mensajes: " + e.code),
  );
}

async function enviar() {
  const texto = $("inputMensaje").value.trim();
  if (!texto) return alert("No puedes enviar un mensaje vacío.");
  if (texto.length > 1000) return alert("El mensaje no puede superar 1000 caracteres.");
  if (!convActiva) return;
  $("inputMensaje").value = "";

  try {
    // El mensaje y el resumen de la conversación se guardan juntos (atómico)
    const batch = writeBatch(db);
    const conv = doc(db, "conversaciones", convActiva);
    batch.set(doc(collection(conv, "mensajes")), {
      emisorId: yo.id,
      emisorNombre: yo.nombre,
      texto,
      creadoEn: serverTimestamp(),
    });
    batch.update(conv, {
      ultimoMensaje: texto.slice(0, 80),
      ultimoEmisorId: yo.id,
      actualizadaEn: serverTimestamp(),
    });
    await batch.commit();
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
function marcarEstado(estado) {
  return setDoc(
    doc(db, "usuarios", yo.id),
    { estado, lastSeen: serverTimestamp() },
    { merge: true },
  );
}

function iniciarPresencia() {
  latido = setInterval(() => {
    marcarEstado("online");
    // Si alguien se desconecta sin avisar no llega ningún cambio de Firestore,
    // así que se vuelve a pintar para que su punto pase a gris tras el umbral.
    pintarUsuarios();
    const c = misConvs.find((x) => x.id === convActiva);
    if (c) cabecera(c);
  }, LATIDO_MS);

  // Best effort: el navegador puede cerrar antes de que se complete
  window.addEventListener("beforeunload", () => marcarEstado("offline"));
}
