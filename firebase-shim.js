// CLOUD Restock Hub — standalone runtime (Firebase Auth + Firestore) that provides the same
// window.claude.use(...) API the page uses inside Claude: db, user, downloads, assets.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, FieldPath, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = window.RH_CONFIG || {};
const ADMINS = (CFG.admins || []).map(e => String(e).toLowerCase());
const app = initializeApp(CFG.firebase);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), ignoreUndefinedProperties: true });

/* ---------- login screen ---------- */
function loginScreen(msg){
  let el = document.getElementById("rhLogin");
  if (!el) {
    el = document.createElement("div"); el.id = "rhLogin";
    el.style.cssText = "position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:var(--bg,#f3f5f4);padding:16px";
    document.body.appendChild(el);
  }
  el.innerHTML = `<div style="max-width:380px;width:100%;background:var(--surface,#fff);border:1px solid var(--line,#dde3e0);border-radius:14px;padding:24px;display:grid;gap:12px;text-align:center">
    <div style="font-weight:800;font-size:20px">CLOUD <span style="color:var(--accent,#1f7a4a)">Restock Hub</span></div>
    <div style="color:var(--ink-2,#4a5a55);font-size:14px">${msg || "Sign in with your Google account to continue."}</div>
    <button id="rhSignIn" class="btn primary" type="button" style="justify-content:center">Sign in with Google</button></div>`;
  document.getElementById("rhSignIn").onclick = async () => {
    const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, p); } catch (e) { if (e && /popup/.test(e.code || "")) signInWithRedirect(auth, p); else loginScreen("Sign-in failed: " + ((e && e.code) || "try again")); }
  };
}

/* ---------- db adapter (same shape as the Claude db capability) ---------- */
const isPlain = v => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function flatten(obj, path = [], out = []){
  for (const k of Object.keys(obj)) {
    const v = obj[k], p = path.concat(k);
    if (isPlain(v) && Object.keys(v).length) flatten(v, p, out); else out.push(new FieldPath(...p), v === undefined ? null : v);
  }
  return out;
}
const wrapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
function docRef(path){
  const r = doc(fs, path);
  return {
    id: r.id, path,
    get: async () => wrapDoc(await getDoc(r)),
    set: d => setDoc(r, d),
    update: d => { const pairs = flatten(d); return pairs.length ? updateDoc(r, ...pairs) : Promise.resolve(); },
    delete: () => deleteDoc(r),
    onSnapshot: (cb, err) => onSnapshot(r, { includeMetadataChanges: false }, s => cb(wrapDoc(s)), e => err && err(e))
  };
}
function colRef(path){
  const c = collection(fs, path);
  return {
    path,
    doc: id => docRef(path + "/" + (id || doc(c).id)),
    add: async d => { const r = await addDoc(c, d); return docRef(path + "/" + r.id); },
    onSnapshot: (cb, err) => onSnapshot(c, { includeMetadataChanges: true }, s => cb({ docs: s.docs.map(wrapDoc), size: s.size, empty: s.empty, metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } }), e => err && err(e))
  };
}
async function deleteMany(paths){ for (let i = 0; i < paths.length; i += 400) { const b = writeBatch(fs); paths.slice(i, i + 400).forEach(p => b.delete(doc(fs, p))); await b.commit(); } }
const db = { doc: docRef, collection: colRef, batch: () => writeBatch(fs), deleteMany };

/* ---------- users / profiles ---------- */
let USERS = {}; let usersReady = null;
function watchUsers(){
  if (usersReady) return usersReady;
  usersReady = new Promise(res => onSnapshot(collection(fs, "users"), s => { USERS = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); res(); }, () => res()));
  return usersReady;
}
function makeUser(u, roleAdmin){
  const isOwner = roleAdmin || ADMINS.includes(String(u.email || "").toLowerCase());
  const prof = id => { const x = USERS[id] || {}; return { id, name: x.name || "", avatarUrl: x.photo || "", guest: false }; };
  return {
    me: async () => ({ id: u.uid, name: u.displayName || u.email || "", avatarUrl: u.photoURL || "", isOwner }),
    id: async () => u.uid, isOwner: () => isOwner, canEdit: () => isOwner, can: async () => true,
    profiles: async ids => { await watchUsers(); return Object.fromEntries([].concat(ids).map(id => [id, prof(id)])); },
    search: async q => { await watchUsers(); q = String(q || "").toLowerCase();
      return Object.entries(USERS).filter(([id, x]) => !q || (x.name || "").toLowerCase().includes(q) || (x.email || "").toLowerCase().includes(q)).slice(0, 20).map(([id, x]) => ({ id, name: (x.name || x.email || "") + (x.email ? " · " + x.email : "") })); }
  };
}

/* ---------- assets: stored in Firestore ("images" collection), chunked ---------- */
const CHUNK = 800000, BLOBS = {}, LOADING = {};
async function blobToString(b, type){ if (/json|text|csv/.test(type)) return await b.text(); return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); }); }
const assets = {
  upload: async (blob, opts = {}) => {
    const type = opts.type || blob.type || "application/octet-stream";
    const str = await blobToString(blob, type);
    const id = doc(collection(fs, "images")).id; const parts = Math.ceil(str.length / CHUNK) || 1;
    for (let i = 1; i < parts; i++) await setDoc(doc(fs, "images", id + "_p" + i), { data: str.slice(i * CHUNK, (i + 1) * CHUNK) });
    await setDoc(doc(fs, "images", id), { type, parts, data: str.slice(0, CHUNK), at: Date.now(), by: auth.currentUser.uid });
    return { id, url: "/_blob/" + id, sizeBytes: blob.size, contentType: type };
  },
  delete: async id => { const s = await getDoc(doc(fs, "images", id)); const n = (s.exists() && s.data().parts) || 1; for (let i = 1; i < n; i++) await deleteDoc(doc(fs, "images", id + "_p" + i)); await deleteDoc(doc(fs, "images", id)); },
  list: async () => ({ assets: [], usage: {} })
};
async function loadBlob(id){
  if (LOADING[id]) return LOADING[id];
  return LOADING[id] = (async () => {
    const s = await getDoc(doc(fs, "images", id)); if (!s.exists()) return null;
    const d = s.data(); let str = d.data || "";
    for (let i = 1; i < (d.parts || 1); i++) { const p = await getDoc(doc(fs, "images", id + "_p" + i)); str += (p.exists() && p.data().data) || ""; }
    return BLOBS[id] = { type: d.type, str };
  })();
}
// <img src> for an uploaded photo
window.__blobSrc = id => { const b = BLOBS[id]; if (b) return b.str; loadBlob(id).then(() => window.__rhRender && window.__rhRender()); return "placeholder.png"; };
// fetch("/_blob/<id>") for uploaded data files (product list)
const _fetch = window.fetch.bind(window);
window.fetch = async (u, o) => {
  const s = typeof u === "string" ? u : (u && u.url) || "";
  const m = s.match(/\/_blob\/([A-Za-z0-9_-]+)/);
  if (!m) return _fetch(u, o);
  const b = await loadBlob(m[1]); if (!b) return new Response("", { status: 404 });
  return new Response(b.str.startsWith("data:") ? await (await _fetch(b.str)).blob() : b.str, { status: 200, headers: { "Content-Type": b.type } });
};

/* ---------- downloads: normal browser download ---------- */
const downloads = { save: async ({ filename, data }) => {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); return { status: "saved" };
} };

/* ---------- boot ---------- */
let resolveReady; window.__rhReady = new Promise(r => resolveReady = r);
onAuthStateChanged(auth, async u => {
  if (!u) { loginScreen(); return; }
  document.getElementById("rhLogin")?.remove();
  try { await setDoc(doc(fs, "users", u.uid), { name: u.displayName || "", email: u.email || "", photo: u.photoURL || "", at: Date.now() }, { merge: true }); } catch (_) {}
  const who = document.querySelector(".who");
  if (who && !document.getElementById("rhOut")) { const b = document.createElement("button"); b.id = "rhOut"; b.className = "btn sm ghost"; b.type = "button"; b.textContent = "Sign out"; b.title = u.email || ""; b.onclick = () => signOut(auth).then(() => location.reload()); who.after(b); }
  let roleAdmin = false; try { const r = await getDoc(doc(fs, "roles", u.uid)); roleAdmin = r.exists() && r.data().team === "admin"; } catch (_) {}
  resolveReady({ db, user: makeUser(u, roleAdmin), downloads, assets });
});
