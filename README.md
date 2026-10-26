# Chat en tiempo real con Cloud Firestore

Taller Streams · Bases de Datos 2 · Universidad de La Salle
Alternativa elegida: **B. Chat web con HTML, CSS y JavaScript** (SDK modular de Firebase 12).

## Cómo ejecutarlo

La página usa módulos ES, así que necesita un servidor local (no basta con abrir el archivo).
Desde la carpeta del proyecto:

```bash
python -m http.server 5500
```

o la extensión **Live Server** de VS Code. Luego abrir `http://localhost:5500`.

| Archivo | Contenido |
|---|---|
| `index.html` | Interfaz: ingreso/registro, listas laterales y área del chat |
| `styles.css` | Estilos |
| `logica.js` | Lógica de la aplicación (equivale al `app.js` del enunciado) |
| `firebase.js` | Inicialización de Firebase y exportación de `db` |
| `firestore.rules` | Reglas de seguridad propuestas |

---

## 1. Arquitectura de datos

```
usuarios/{usuarioId}
    nombre        string     nombre visible (puede repetirse)
    estado        string     "online" | "offline" (lo que reporta el cliente)
    lastSeen      timestamp  último latido, hora del servidor
    creadoEn      timestamp  fecha de registro

conversaciones/{conversacionId}
    tipo          string     "privada" | "grupo"
    participantes array      IDs de usuario
    nombre        string     solo en grupos
    creadaPor     string     solo en grupos
    creadaEn      timestamp
    actualizadaEn timestamp  hora del último mensaje
    ultimoMensaje string     vista previa (máx. 80 caracteres)
    ultimoEmisorId string    quién envió el último mensaje

    mensajes/{mensajeId}            (subcolección)
        emisorId     string     ID de quien envía
        emisorNombre string     nombre visible al momento de enviar
        texto        string     1 a 1000 caracteres
        creadoEn     timestamp  hora del servidor (serverTimestamp)
```

### Justificación: qué consulta u operación permite cada parte

| Elemento | Para qué se usa |
|---|---|
| `usuarios/{usuarioId}` con el ID como clave del documento | Leer o crear un usuario con `getDoc`/`setDoc` sin consultas. El ID es la identidad y es **distinto del nombre visible**: dos personas pueden llamarse "Santiago" sin confundirse. |
| `estado` + `lastSeen` | Mostrar la lista de usuarios con su disponibilidad (`onSnapshot(collection("usuarios"))`). |
| `conversaciones` como colección raíz (no dentro de cada usuario) | Una conversación pertenece a todos sus participantes. Si estuviera dentro de `usuarios/u001` habría que duplicarla en `usuarios/u002`. |
| `participantes` (array) | Consulta "mis conversaciones": `where("participantes", "array-contains", miId)`. Sirve igual para chats privados y grupos. |
| `tipo` | Consulta "salas disponibles": `where("tipo", "==", "grupo")`, y distinguir cómo se titula cada chat. |
| `ultimoMensaje`, `ultimoEmisorId`, `actualizadaEn` | Pintar la lista de conversaciones ordenada y con vista previa **sin leer la subcolección de mensajes** de cada una. Es una desnormalización: se actualiza en el mismo *batch* que guarda el mensaje. |
| `mensajes` como **subcolección** | Los mensajes pueden ser miles; en un array dentro del documento se superaría el límite de 1 MiB por documento y cada mensaje reescribiría todo el chat. En subcolección se consultan con `orderBy("creadoEn")` y se escuchan por separado. |
| `emisorNombre` en el mensaje | Mostrar el nombre sin buscar al usuario. Es una copia: si el usuario cambia su nombre, los mensajes viejos conservan el anterior (limitación aceptada). |
| `creadoEn = serverTimestamp()` | El orden lo decide el reloj del servidor, no el de cada computador (que puede estar adelantado o atrasado). |

### Consultas que usa la aplicación

| Consulta | Código | Tipo |
|---|---|---|
| Todos los usuarios | `collection(db, "usuarios")` | `onSnapshot` |
| Mis conversaciones | `query(conversaciones, where("participantes", "array-contains", yo.id))` | `onSnapshot` |
| Salas | `query(conversaciones, where("tipo", "==", "grupo"))` | `onSnapshot` |
| Mensajes de un chat | `query(conversaciones/{id}/mensajes, orderBy("creadoEn", "asc"))` | `onSnapshot` |
| Un usuario / una conversación | `doc(db, "usuarios", id)` / `doc(db, "conversaciones", id)` | `getDoc` / transacción |

Ninguna necesita índice compuesto (cada una filtra u ordena por un solo campo).
La lista de conversaciones se ordena por `actualizadaEn` en el cliente para no requerir un índice `participantes + actualizadaEn`.

---

## 2. Consistencia

### Identificador de usuario único
- Los IDs de documento en Firestore **distinguen mayúsculas y minúsculas**: `u023` y `U023` son documentos diferentes. Esto ocurrió en la base (existen `U001` y `u001`, ambos "santiago").
- Solución: los IDs nuevos se guardan **en mayúsculas**. Al registrar se busca el ID tal como se escribió y también en mayúsculas; si cualquiera existe, se rechaza. Los IDs antiguos en minúscula siguen pudiendo ingresar.
- Solo se permiten letras, números y guiones (2 a 20). El guion bajo `_` no se permite porque se usa para formar los IDs de chats privados.
- El registro se hace en una **transacción** (`runTransaction`): si dos personas registran el mismo ID al mismo tiempo, solo una lo logra.

### Conversaciones privadas sin duplicados
El ID de la conversación es **determinista**: los dos IDs ordenados y unidos con `_`.

```
U002 abre chat con U001  ->  ["U001","U002"].sort().join("_")  ->  "U001_U002"
U001 abre chat con U002  ->  mismo ID                          ->  "U001_U002"
```

Como la clave del documento es única en la colección, **no pueden existir dos documentos** para la misma pareja. No hace falta buscar con `where` y comparar participantes.

**¿Y si los dos lo crean al mismo tiempo?** Se usa `runTransaction`: lee el documento y solo lo crea si no existe. Si otra persona lo creó entre la lectura y la escritura, Firestore detecta el conflicto y **reintenta** la transacción; en el reintento el documento ya existe y simplemente se reutiliza. La regla de seguridad además exige que el ID sea `participantes[0] + "_" + participantes[1]`.

### Salas sin nombres repetidos
El ID de la sala sale del nombre normalizado (`"Bases de Datos"` → `sala-bases-de-datos`) y se crea con transacción, así no se crean dos salas con el mismo nombre. *(Las salas creadas antes de este cambio tienen IDs aleatorios de `addDoc`.)*

### Mensaje y resumen juntos
Al enviar, el mensaje y los campos `ultimoMensaje`/`actualizadaEn` de la conversación se escriben en un **`writeBatch`**: o se guardan los dos, o ninguno.

### Recepción de mensajes
- Se escucha la subcolección con `onSnapshot` y se procesan solo los cambios (`docChanges()`): agregar, modificar o quitar, en vez de volver a pintar todo el historial con cada mensaje.
- Mientras el servidor no confirma, el mensaje propio aparece con "enviando…" y una hora estimada (`serverTimestamps: "estimate"`); al confirmarse se reemplaza por la hora del servidor.
- **Al cambiar de conversación se cancela el listener anterior** (la función que devuelve `onSnapshot`) y se limpia el área de mensajes, así no se mezclan chats. Al salir se cancelan todos los listeners.
- Si llega un mensaje a un chat que no está abierto, en la lista aparece la etiqueta **"nuevo"**.

---

## 3. Usuarios y presencia

- **Identificación:** ID de prueba (ej. `U060`) + nombre visible. No se implementó Firebase Authentication (el enunciado lo permite para esta sesión).
- **Estrategia:** al entrar se escribe `estado: "online"` y `lastSeen = serverTimestamp()`. Cada **30 s** se envía un "latido" que actualiza `lastSeen`. Al pulsar *Salir* o cerrar la pestaña se escribe `estado: "offline"`.
- **Umbral:** un usuario se muestra disponible (punto verde) solo si `estado == "online"` **y** su `lastSeen` tiene menos de **60 s**. La lista se vuelve a evaluar cada 30 s para que el punto pase a gris aunque no llegue ningún cambio.
- La lista muestra primero a los disponibles y, para los demás, "visto hace X min".

### Limitaciones reconocidas
1. **Cierre inesperado** (se va la luz, se pierde la red, se mata el navegador): el `"offline"` nunca se escribe. Por eso existe el umbral: tras ~60 s sin latido el usuario se ve desconectado, aunque en la base siga diciendo `"online"`.
2. El evento `beforeunload` es "mejor esfuerzo": el navegador puede cerrarse antes de que la escritura llegue.
3. El umbral compara la hora del servidor (`lastSeen`) con el reloj del computador que mira; si ese reloj está muy desfasado el indicador puede fallar.
4. Sin autenticación, cualquiera que conozca un ID puede entrar como ese usuario. Las reglas solo validan la forma de los datos, no la identidad.
5. La solución completa sería **Realtime Database con `onDisconnect()`**, que el servidor ejecuta cuando se cae la conexión, y sincronizar ese estado a Firestore con una Cloud Function. No se implementó.

---

## 4. Reglas de seguridad

`firestore.rules` propone reglas que (sin autenticación) validan:
- usuarios: nombre de 1 a 40 caracteres; en actualizaciones solo se pueden cambiar `estado` y `lastSeen`;
- conversaciones privadas: 2 participantes ordenados y ID = `p0_p1`;
- mensajes: texto de 1 a 1000 caracteres, `creadoEn` igual a la hora del servidor, emisor que sea participante; no se pueden editar ni borrar.

Debe publicarlas el dueño del proyecto Firebase (Firestore → Reglas).

**Borrado:** si se borrara una conversación con `deleteDoc`, su subcolección `mensajes` **no** se borra automáticamente (queda huérfana). Por eso las reglas no permiten borrar conversaciones ni mensajes.

---

## 5. Pruebas funcionales

Probar con **dos ventanas** (una normal y otra en incógnito), cada una con un usuario distinto.

| ID | Prueba | Pasos | Resultado esperado | Resultado obtenido | Evidencia |
|---|---|---|---|---|---|
| P1 | Registrar dos usuarios | Registrar `U060 - Ana` y `U061 - Carlos` | Ambos aparecen en `usuarios` con IDs únicos | | |
| P1b | Registrar ID repetido | Registrar `u060` (minúscula) | Se rechaza: "El identificador U060 ya existe" | | |
| P2 | Consultar usuarios | Entrar como Ana | La lista muestra a los demás, no a Ana; Carlos con punto verde | | |
| P3 | Seleccionar destinatario | Ana hace clic en Carlos | Se abre la conversación `U060_U061` | | |
| P3b | No duplicar | Carlos hace clic en Ana | Abre la **misma** conversación `U060_U061` (ver consola de Firebase: un solo documento) | | |
| P4 | Enviar mensaje | Ana escribe "Hola" | Se guarda en `conversaciones/U060_U061/mensajes` con `emisorId`, `texto`, `creadoEn` | | |
| P5 | Mensaje desde otra instancia | Carlos responde desde la otra ventana | Ana lo ve sin recargar, con hora | | |
| P6 | Mensaje vacío | Enviar con el campo vacío o solo espacios | Se rechaza con un aviso, no se guarda nada | | |
| P7 | Cambiar de conversación | Abrir otro chat y volver | No se mezclan mensajes de chats distintos | | |
| P8 | Presencia | Cerrar la ventana de Carlos sin pulsar Salir | En ~60 s su punto pasa a gris en la ventana de Ana | | |

En la columna *Evidencia* va la captura de pantalla (app + consola de Firestore).
