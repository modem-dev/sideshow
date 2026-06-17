// E2E-encryption PoC for sideshow — runs against the CURRENT build, no server
// or viewer changes. The server is already just a relay: it stores whatever
// string you publish and renders html parts client-side in a sandboxed iframe.
// So we publish ciphertext + an inline decryptor; the key never reaches the
// server. Works on http://localhost (a secure context, so crypto.subtle is live).
//
// Usage:
//   PASSPHRASE=hunter2 node e2e-poc/poc.mjs publish "<h2>Secret</h2><p>...</p>"
//   PASSPHRASE=hunter2 node e2e-poc/poc.mjs read <sessionId>
//   node e2e-poc/poc.mjs selftest

const BASE = process.env.SIDESHOW_URL || "http://localhost:4242";
const subtle = globalThis.crypto.subtle;

// --- shared crypto (identical API in Node and the browser) ---
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const ITER = 200000;

async function deriveKey(passphrase, salt) {
  const base = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(plaintext, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  return { v: 1, kdf: "PBKDF2", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function decrypt(bundle, passphrase) {
  const key = await deriveKey(passphrase, unb64(bundle.salt));
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(bundle.iv) }, key, unb64(bundle.ct));
  return new TextDecoder().decode(pt);
}

// --- the html part: ciphertext + an inline browser-side decryptor ---
// Everything here runs inside the sandboxed iframe. The bundle is the only
// thing the server ever sees. The passphrase is typed in the iframe and never
// leaves the browser. Encrypted replies go back through sendPrompt().
function buildSurfaceHtml(bundle) {
  const bundleJson = JSON.stringify(bundle);
  return `
<div id="gate">
  <p style="color:var(--color-text-secondary)">Encrypted surface — the server only stored ciphertext.</p>
  <input id="pass" type="password" placeholder="passphrase" autocomplete="off" />
  <button id="unlock">Unlock</button>
  <span id="err" style="color:var(--color-text-danger);font-size:13px"></span>
</div>
<div id="content"></div>
<div id="replybox" style="display:none;margin-top:16px">
  <input id="reply" placeholder="reply (encrypted before it leaves the page)" style="width:60%" />
  <button id="send">Send encrypted</button>
</div>
<script id="bundle" type="application/json">${bundleJson}</script>
<script>
(function () {
  var subtle = crypto.subtle, KEY = null;
  var bundle = JSON.parse(document.getElementById('bundle').textContent);
  var dec = function (b64) { return Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); }); };
  var enc64 = function (u8) { var s = ''; u8.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s); };
  async function keyFrom(pass, salt) {
    var base = await subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: bundle.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  document.getElementById('unlock').onclick = async function () {
    var pass = document.getElementById('pass').value;
    try {
      KEY = await keyFrom(pass, dec(bundle.salt));
      var pt = await subtle.decrypt({ name: 'AES-GCM', iv: dec(bundle.iv) }, KEY, dec(bundle.ct));
      document.getElementById('content').innerHTML = new TextDecoder().decode(pt);
      document.getElementById('gate').style.display = 'none';
      document.getElementById('replybox').style.display = 'block';
    } catch (e) {
      document.getElementById('err').textContent = ' wrong passphrase';
      KEY = null;
    }
  };
  document.getElementById('send').onclick = async function () {
    if (!KEY) return;
    var text = document.getElementById('reply').value;
    if (!text) return;
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv }, KEY, new TextEncoder().encode(text)));
    // Reuse the surface's salt so the agent derives the same key. Send ciphertext only.
    sendPrompt(JSON.stringify({ v: 1, salt: bundle.salt, iv: enc64(iv), ct: enc64(ct) }));
    document.getElementById('reply').value = '';
  };
})();
</script>`;
}

// --- commands ---
async function publish(plaintext) {
  const pass = process.env.PASSPHRASE;
  if (!pass) throw new Error("set PASSPHRASE");
  const bundle = await encrypt(plaintext, pass);
  const body = {
    title: "Encrypted surface", // NOTE: title is metadata — stays plaintext
    parts: [{ kind: "html", html: buildSurfaceHtml(bundle) }],
    agent: "e2e-poc",
    sessionTitle: "E2E encryption PoC",
  };
  const res = await fetch(`${BASE}/api/surfaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log("published:", { surfaceId: json.id, sessionId: json.sessionId });
  console.log(`Open ${BASE} in a browser, unlock with the passphrase to render it.`);
  return json;
}

async function read(sessionId) {
  const pass = process.env.PASSPHRASE;
  const res = await fetch(`${BASE}/api/comments?session=${sessionId}&author=user`);
  const { comments } = await res.json();
  for (const c of comments) {
    try {
      const plain = await decrypt(JSON.parse(c.text), pass);
      console.log(`decrypted reply: ${plain}`);
    } catch {
      console.log(`(plaintext / undecryptable comment): ${c.text}`);
    }
  }
}

async function selftest() {
  const plaintext = "<h2>top secret diagram</h2>";
  const bundle = await encrypt(plaintext, "correct horse");
  console.log("bundle the server would store:", JSON.stringify(bundle).slice(0, 90) + " …");
  console.log("contains plaintext?", JSON.stringify(bundle).includes("secret diagram"));
  console.log(
    "round-trips with right passphrase?",
    (await decrypt(bundle, "correct horse")) === plaintext,
  );
  try {
    await decrypt(bundle, "wrong");
    console.log("wrong passphrase: DECRYPTED (bad!)");
  } catch {
    console.log("wrong passphrase: rejected (good)");
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "publish") await publish(arg);
else if (cmd === "read") await read(arg);
else if (cmd === "selftest") await selftest();
else console.log("usage: poc.mjs publish <html> | read <sessionId> | selftest");
