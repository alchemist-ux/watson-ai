const os = require("os")

function escapeXml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
}

function escapePdfText(value) {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
}

function slugifyFileName(text, fallback = "file") {
    const slug = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 54)

    return slug || fallback
}

function stripAgentCommand(text) {
    return String(text || "")
        .replace(/^!?\s*(?:agent|file|dokumen|buatfile|buat\s+file|generate\s+file)\s*/i, "")
        .replace(/^(?:tolong|coba|bantu|buat|buatkan|bikin|bikinkan|buatin|generate|create|susun|tulis|jadikan|perbaiki|fix|repair|revisi|ubah|update)\s+/i, "")
        .replace(/^(?:file\s+)?(?:pdf|word|docx|microsoft word|ms word|surat|proposal|laporan|makalah|ringkasan|simulasi|simulation|simulator|railway(?:\.json)?|github(?: actions?| workflow)?|workflow|json|csv|html|markdown|md|env(?: example)?|\.env\.example|kode|script|txt)\s*/i, "")
        .trim()
}

function wantsSimulationArtifact(text) {
    const lower = String(text || "").toLowerCase()
    const hasSimulationWord = /\b(simulasi|simulation|simulator|simulasikan|simulasikanlah)\b/.test(lower)
    const hasAction = /\b(buat|buatkan|buatin|bikin|bikinkan|generate|create|siapkan|simulasikan|simulasikanlah|perbaiki|fix|repair|revisi|ubah|update)\b/.test(lower)
    return hasSimulationWord && (hasAction || /^(?:simulasi|simulation|simulator)\b/.test(lower))
}

function detectAgentArtifactRequest(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return null

    const lower = trimmed.toLowerCase()
    const wantsSimulation = wantsSimulationArtifact(trimmed)
    const typeRules = [
        ["pdf", /\b(pdf|proposal pdf|laporan pdf|dokumen pdf|jadikan pdf)\b/i],
        ["docx", /\b(word|docx|microsoft word|ms word|dokumen word|surat|proposal|laporan|makalah)\b/i],
        ["railway", /\b(railway|railway\.json|deploy railway)\b/i],
        ["github", /\b(github action|github actions|github workflow|workflow github|ci\/cd|ci cd|deploy github)\b/i],
        ["env", /\b(env example|\.env\.example|contoh env|env file)\b/i],
        ["json", /\b(json|file json)\b/i],
        ["csv", /\b(csv|spreadsheet|tabel csv)\b/i],
        ["html", /\b(html|file html|website html|landing page)\b/i],
        ["markdown", /\b(markdown|readme|md file|file md)\b/i],
        ["code", /\b(javascript|typescript|python|nodejs|node\.js|kode|script)\b/i],
        ["text", /\b(txt|file text|catatan|dokumen|ringkasan)\b/i],
    ]

    const hasCreateIntent = /\b(buat|buatkan|buatin|bikin|bikinkan|generate|create|tulis|susun|jadikan|siapkan|simulasikan|simulasikanlah|perbaiki|fix|repair|revisi|ubah|update)\b/i.test(lower) || wantsSimulation
    const explicitAgent = /^!?\s*(?:agent|file|dokumen|buatfile|buat\s+file|generate\s+file)\b/i.test(trimmed)
    if (!hasCreateIntent && !explicitAgent) return null

    if (wantsSimulation) {
        return {
            type: "simulation",
            prompt: stripAgentCommand(trimmed) || trimmed,
        }
    }

    const match = typeRules.find(([, pattern]) => pattern.test(trimmed))
    if (!match) return null

    return {
        type: match[0],
        prompt: stripAgentCommand(trimmed),
    }
}

function splitLines(text, maxLen = 86) {
    const result = []
    for (const rawLine of String(text || "").replace(/\r/g, "").split("\n")) {
        const words = rawLine.trim().split(/\s+/).filter(Boolean)
        if (!words.length) {
            result.push("")
            continue
        }

        let line = ""
        for (const word of words) {
            if (!line) {
                line = word
            } else if (`${line} ${word}`.length <= maxLen) {
                line += ` ${word}`
            } else {
                result.push(line)
                line = word
            }
        }
        if (line) result.push(line)
    }
    return result
}

function createPdfBuffer(title, body) {
    const lines = splitLines(`${title}\n\n${body}`, 88).slice(0, 58)
    const commands = ["BT", "/F1 18 Tf", "50 790 Td", `(${escapePdfText(title).slice(0, 90)}) Tj`, "/F1 11 Tf", "0 -28 Td"]

    for (const line of splitLines(body, 92).slice(0, 62)) {
        if (!line) {
            commands.push("0 -14 Td")
            continue
        }
        commands.push(`(${escapePdfText(line).slice(0, 120)}) Tj`)
        commands.push("0 -15 Td")
    }
    commands.push("ET")

    const stream = commands.join("\n")
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    ]

    let pdf = "%PDF-1.4\n"
    const offsets = [0]
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(pdf, "ascii"))
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    })

    const xrefOffset = Buffer.byteLength(pdf, "ascii")
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (let i = 1; i < offsets.length; i += 1) {
        pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

    return Buffer.from(pdf, "ascii")
}

function crc32(buffer) {
    let crc = 0xffffffff
    for (const byte of buffer) {
        crc ^= byte
        for (let i = 0; i < 8; i += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
        }
    }
    return (crc ^ 0xffffffff) >>> 0
}

function u16(value) {
    const buffer = Buffer.alloc(2)
    buffer.writeUInt16LE(value)
    return buffer
}

function u32(value) {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value >>> 0)
    return buffer
}

function createZip(entries) {
    const localParts = []
    const centralParts = []
    let offset = 0

    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8")
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ""), "utf8")
        const crc = crc32(data)

        const local = Buffer.concat([
            u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
        ])
        localParts.push(local)

        centralParts.push(Buffer.concat([
            u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
            u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
            u16(0), u16(0), u32(0), u32(offset), name,
        ]))

        offset += local.length
    }

    const central = Buffer.concat(centralParts)
    const end = Buffer.concat([
        u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
        u32(central.length), u32(offset), u16(0),
    ])

    return Buffer.concat([...localParts, central, end])
}

function createDocxBuffer(title, body) {
    const paragraphs = String(`${title}\n\n${body}`)
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
        .join("")

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`

    return createZip([
        {
            name: "[Content_Types].xml",
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
        },
        {
            name: "_rels/.rels",
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
        },
        { name: "word/document.xml", data: documentXml },
    ])
}

function makeRailwayFile(prompt) {
    const service = slugifyFileName(prompt, "watson-app")
    return JSON.stringify({
        "$schema": "https://railway.app/railway.schema.json",
        build: {
            builder: "NIXPACKS",
        },
        deploy: {
            startCommand: "npm start",
            restartPolicyType: "ON_FAILURE",
            restartPolicyMaxRetries: 10,
        },
        service,
    }, null, 2)
}

function makeGithubWorkflow(prompt) {
    const appName = slugifyFileName(prompt, "node-app")
    return `name: ${appName} CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Check syntax
        run: node --check index.js
`
}

function makeEnvExample() {
    return [
        "OPENROUTER_API_KEY=",
        "GEMINI_API_KEY=",
        "IMAGE_PROVIDER=puter",
        "PUTER_AUTH_TOKEN=",
        "PUTER_IMAGE_PROVIDER=openai-image-generation",
        "PUTER_IMAGE_MODEL=openai/gpt-image-1-mini",
        "NATURAL_CHAT=true",
        "NATURAL_CHAT_GROUPS=true",
    ].join(os.EOL)
}

function makeCodeFile(prompt) {
    const lower = String(prompt || "").toLowerCase()
    if (/\bpython|\.py\b/.test(lower)) {
        return {
            fileName: `${slugifyFileName(prompt, "script")}.py`,
            mimetype: "text/x-python",
            content: `def main():\n    print("Halo dari script yang dibuat Watson")\n\n\nif __name__ == "__main__":\n    main()\n`,
        }
    }

    return {
        fileName: `${slugifyFileName(prompt, "script")}.js`,
        mimetype: "application/javascript",
        content: `function main() {\n    console.log("Halo dari script yang dibuat Watson")\n}\n\nmain()\n`,
    }
}

function makeRocketSimulationHtml(prompt, pushname) {
    const topic = String(prompt || "").trim() || "simulasi roket"
    const safeTopic = escapeXml(topic)
    const fileName = `${slugifyFileName(topic, "simulasi-roket")}.html`

    const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Simulasi Roket - ${safeTopic}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08111f;
      --panel: rgba(8, 17, 31, 0.92);
      --panel-2: rgba(12, 24, 43, 0.92);
      --text: #ecf2ff;
      --muted: #9fb0cc;
      --accent: #4fd1c5;
      --accent-2: #f59e0b;
      --danger: #fb7185;
      --line: rgba(160, 180, 210, 0.18);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(79, 209, 197, 0.12), transparent 25%),
        radial-gradient(circle at top right, rgba(245, 158, 11, 0.10), transparent 26%),
        linear-gradient(180deg, #07101d 0%, #0b1628 100%);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .topbar {
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(5, 10, 20, 0.78);
      backdrop-filter: blur(10px);
    }
    .title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 1.5fr) minmax(290px, 0.95fr);
      gap: 0;
      min-height: 0;
    }
    .stage {
      position: relative;
      min-height: 0;
      border-right: 1px solid var(--line);
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      background: linear-gradient(180deg, rgba(6, 11, 20, 0.0), rgba(6, 11, 20, 0.2));
    }
    .panel {
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      background: var(--panel);
      min-height: 0;
    }
    .section {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }
    .section h2 {
      margin: 0 0 10px;
      font-size: 14px;
      letter-spacing: 0;
    }
    .controls {
      display: grid;
      gap: 10px;
    }
    .control {
      display: grid;
      gap: 6px;
    }
    .control label {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      color: var(--muted);
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      appearance: none;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 700;
    }
    button.primary {
      background: linear-gradient(180deg, rgba(79, 209, 197, 0.22), rgba(79, 209, 197, 0.10));
      border-color: rgba(79, 209, 197, 0.35);
    }
    button.warn {
      background: linear-gradient(180deg, rgba(245, 158, 11, 0.20), rgba(245, 158, 11, 0.08));
      border-color: rgba(245, 158, 11, 0.30);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .metric {
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--panel-2);
      border: 1px solid var(--line);
    }
    .metric .k {
      color: var(--muted);
      font-size: 12px;
    }
    .metric .v {
      margin-top: 4px;
      font-size: 18px;
      font-weight: 700;
    }
    .formula {
      padding: 14px 16px;
      font-size: 13px;
      color: #d8e3f7;
      line-height: 1.55;
      overflow: auto;
      min-height: 0;
    }
    .formula code {
      color: #fcd34d;
    }
    .footer {
      padding: 12px 16px;
      color: var(--muted);
      font-size: 12px;
      border-top: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.02);
    }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .stage { min-height: 56vh; border-right: 0; border-bottom: 1px solid var(--line); }
      .panel { grid-template-rows: auto auto auto auto; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <h1 class="title">Simulasi Roket</h1>
      <p class="subtitle">${escapeXml(pushname)} - ${safeTopic}</p>
    </header>
    <div class="layout">
      <section class="stage">
        <canvas id="c"></canvas>
      </section>
      <aside class="panel">
        <section class="section">
          <h2>Kontrol</h2>
          <div class="controls">
            <div class="control"><label><span>Thrust</span><span id="thrustVal"></span></label><input id="thrust" type="range" min="20" max="160" value="88"></div>
            <div class="control"><label><span>Mass</span><span id="massVal"></span></label><input id="mass" type="range" min="1" max="18" step="0.5" value="7"></div>
            <div class="control"><label><span>Fuel</span><span id="fuelVal"></span></label><input id="fuel" type="range" min="20" max="240" value="130"></div>
            <div class="control"><label><span>Angle</span><span id="angleVal"></span></label><input id="angle" type="range" min="-25" max="85" value="72"></div>
            <div class="control"><label><span>Gravity</span><span id="gravityVal"></span></label><input id="gravity" type="range" min="1" max="18" step="0.1" value="9.8"></div>
          </div>
        </section>
        <section class="section">
          <div class="actions">
            <button class="primary" id="playBtn">Jalankan</button>
            <button id="pauseBtn">Jeda</button>
            <button class="warn" id="resetBtn">Reset</button>
          </div>
        </section>
        <section class="section">
          <div class="metrics">
            <div class="metric"><div class="k">Kecepatan</div><div class="v" id="speedVal">0</div></div>
            <div class="metric"><div class="k">Ketinggian</div><div class="v" id="altVal">0</div></div>
            <div class="metric"><div class="k">Jarak</div><div class="v" id="distVal">0</div></div>
            <div class="metric"><div class="k">Waktu</div><div class="v" id="timeVal">0</div></div>
          </div>
        </section>
        <section class="formula">
          <div><strong>Rumus dasar</strong></div>
          <div><code>a = (T / m) - g</code></div>
          <div><code>v = v + a * dt</code></div>
          <div><code>h = h + v_y * dt</code></div>
          <div style="margin-top:10px;">
            Simulasi ini menggabungkan dorong, massa, gravitasi, dan sisa bahan bakar memakai integrasi waktu sederhana.
            Cocok untuk demonstrasi awal, bukan model fisika tingkat tinggi.
          </div>
        </section>
        <div class="footer">Dibuat oleh Watson. Jalankan lagi untuk coba kombinasi parameter lain.</div>
      </aside>
    </div>
  </div>
  <script>
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const els = {
      thrust: document.getElementById('thrust'),
      mass: document.getElementById('mass'),
      fuel: document.getElementById('fuel'),
      angle: document.getElementById('angle'),
      gravity: document.getElementById('gravity'),
      thrustVal: document.getElementById('thrustVal'),
      massVal: document.getElementById('massVal'),
      fuelVal: document.getElementById('fuelVal'),
      angleVal: document.getElementById('angleVal'),
      gravityVal: document.getElementById('gravityVal'),
      speedVal: document.getElementById('speedVal'),
      altVal: document.getElementById('altVal'),
      distVal: document.getElementById('distVal'),
      timeVal: document.getElementById('timeVal'),
      playBtn: document.getElementById('playBtn'),
      pauseBtn: document.getElementById('pauseBtn'),
      resetBtn: document.getElementById('resetBtn'),
    };

    const state = {
      running: false,
      time: 0,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      trail: [],
      fuel: 0,
      width: 0,
      height: 0,
    };

    function resize() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * devicePixelRatio));
      state.width = canvas.width;
      state.height = canvas.height;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    function fmt(n, d = 0) {
      return Number(n).toFixed(d);
    }

    function read() {
      const thrust = Number(els.thrust.value);
      const mass = Number(els.mass.value);
      const fuelMax = Number(els.fuel.value);
      const angle = Number(els.angle.value) * Math.PI / 180;
      const gravity = Number(els.gravity.value);
      return { thrust, mass, fuelMax, angle, gravity };
    }

    function syncLabels() {
      const r = read();
      els.thrustVal.textContent = fmt(r.thrust, 0) + ' N';
      els.massVal.textContent = fmt(r.mass, 1) + ' kg';
      els.fuelVal.textContent = fmt(r.fuelMax, 0) + ' unit';
      els.angleVal.textContent = fmt(Number(els.angle.value), 0) + ' deg';
      els.gravityVal.textContent = fmt(r.gravity, 1) + ' m/s^2';
    }

    function reset() {
      const cfg = read();
      state.running = false;
      state.time = 0;
      state.x = 0;
      state.y = 0;
      state.vx = 0;
      state.vy = 0;
      state.trail = [];
      state.fuel = cfg.fuelMax;
      updateMetrics();
      syncLabels();
    }

    function updateMetrics() {
      const speed = Math.hypot(state.vx, state.vy);
      els.speedVal.textContent = fmt(speed, 1) + ' m/s';
      els.altVal.textContent = fmt(Math.max(0, state.y), 1) + ' m';
      els.distVal.textContent = fmt(Math.max(0, state.x), 1) + ' m';
      els.timeVal.textContent = fmt(state.time, 1) + ' s';
    }

    function step(dt) {
      const cfg = read();
      const burn = Math.min(state.fuel, cfg.thrust * dt * 0.8);
      const thrustNow = burn > 0 ? cfg.thrust : 0;
      state.fuel = Math.max(0, state.fuel - burn);

      const mass = cfg.mass + Math.max(0, state.fuel) * 0.01;
      const ax = (thrustNow * Math.cos(cfg.angle)) / mass;
      const ay = (thrustNow * Math.sin(cfg.angle)) / mass - cfg.gravity;

      state.vx += ax * dt;
      state.vy += ay * dt;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      state.time += dt;

      if (state.y < 0) {
        state.y = 0;
        state.vy *= -0.18;
        state.vx *= 0.98;
      }

      state.trail.push({ x: state.x, y: state.y });
      if (state.trail.length > 220) state.trail.shift();
      updateMetrics();
    }

    function drawBackground(w, h) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#09131f');
      g.addColorStop(1, '#0f2239');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(159,176,204,0.10)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 10; i++) {
        const y = h * (i / 10);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      for (let i = 0; i < 12; i++) {
        const x = w * (i / 12);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i < 90; i++) {
        const px = (i * 97) % w;
        const py = (i * 53) % (h * 0.5);
        ctx.fillRect(px, py, 2, 2);
      }
    }

    function drawRocket(screenX, screenY, angle) {
      ctx.save();
      ctx.translate(screenX, screenY);
      ctx.rotate(angle);
      ctx.fillStyle = '#e5ecff';
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.quadraticCurveTo(0, -12, -18, 0);
      ctx.lineTo(-12, 36);
      ctx.quadraticCurveTo(0, 48, 12, 36);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#4fd1c5';
      ctx.beginPath();
      ctx.moveTo(-7, 6);
      ctx.lineTo(-22, 20);
      ctx.lineTo(-10, 24);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(7, 6);
      ctx.lineTo(22, 20);
      ctx.lineTo(10, 24);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#fb7185';
      ctx.beginPath();
      ctx.moveTo(-7, 34);
      ctx.lineTo(0, 50);
      ctx.lineTo(7, 34);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function render() {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);
      drawBackground(w, h);

      const scale = 1.4;
      const baseX = 70;
      const baseY = h - 80;
      const sx = baseX + state.x * scale;
      const sy = baseY - state.y * scale;
      const angle = Math.atan2(state.vy, Math.max(0.01, state.vx)) - Math.PI / 2;

      ctx.strokeStyle = 'rgba(79, 209, 197, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < state.trail.length; i++) {
        const p = state.trail[i];
        const tx = baseX + p.x * scale;
        const ty = baseY - p.y * scale;
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, baseY + 1);
      ctx.lineTo(w, baseY + 1);
      ctx.stroke();

      ctx.fillStyle = '#dbe7ff';
      ctx.font = '13px Arial';
      ctx.fillText('0 m', 10, baseY - 8);
      ctx.fillText(fmt(state.y, 0) + ' m', Math.min(w - 64, sx + 16), Math.max(24, sy - 16));

      const flame = state.fuel > 0 && state.running ? 1 : 0;
      if (flame) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        const pulse = 14 + Math.sin(state.time * 14) * 4;
        ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
        ctx.beginPath();
        ctx.moveTo(-8, 38);
        ctx.lineTo(0, 38 + pulse);
        ctx.lineTo(8, 38);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      drawRocket(sx, sy, angle);
    }

    let last = performance.now();
    function loop(now) {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      if (state.running) step(dt);
      render();
      requestAnimationFrame(loop);
    }

    els.playBtn.addEventListener('click', () => { state.running = true; });
    els.pauseBtn.addEventListener('click', () => { state.running = false; });
    els.resetBtn.addEventListener('click', reset);
    for (const el of [els.thrust, els.mass, els.fuel, els.angle, els.gravity]) {
      el.addEventListener('input', () => {
        syncLabels();
        if (!state.running) updateMetrics();
      });
    }

    window.addEventListener('resize', resize);
    resize();
    reset();
    syncLabels();
    requestAnimationFrame(loop);
  </script>
</body>
</html>`;

    return {
        fileName,
        mimetype: "text/html",
        buffer: Buffer.from(html, "utf8"),
        caption: "Simulasi roket HTML sudah dibuat. Buka file ini di browser untuk lihat animasinya.",
    }
}

async function draftContent(prompt, pushname, askText) {
    const topic = String(prompt || "").trim() || "dokumen baru"
    if (typeof askText !== "function") {
        return `Judul: ${topic}\n\nDokumen ini dibuat untuk ${pushname}.\n\nRingkasan:\n- Tujuan utama: ${topic}\n- Isi bisa dikembangkan sesuai kebutuhan.\n- Gunakan file ini sebagai draft awal.`
    }

    const answer = await askText([
        "Buat isi dokumen dalam bahasa Indonesia yang rapi dan langsung siap ditempel ke file.",
        "Jangan pakai markdown berlebihan.",
        "Struktur: judul, ringkasan, poin utama, langkah berikutnya.",
        `Nama user: ${pushname}.`,
        `Permintaan: ${topic}`,
    ].join("\n"))

    if (/bot sedang error|AI teks lagi tidak bisa|SUB 1\.0 gagal|GEMINI_API_KEY|request .*timeout/i.test(String(answer || ""))) {
        return `Judul: ${topic}\n\nRingkasan:\nDraft ini dibuat otomatis sebagai kerangka awal.\n\nPoin utama:\n1. Jelaskan tujuan dokumen.\n2. Tambahkan konteks dan data pendukung.\n3. Susun langkah kerja berikutnya.\n\nLangkah berikutnya:\nLengkapi detail sesuai kebutuhan.`
    }

    return String(answer || "").trim()
}

async function buildAgentArtifact(request, pushname, askText) {
    const type = request?.type || "text"
    const prompt = request?.prompt || "dokumen baru"
    const title = prompt.replace(/^(?:pdf|word|docx|dokumen|file)\s+/i, "").trim() || "Dokumen Watson"
    const slug = slugifyFileName(title, "dokumen-watson")

    if (type === "railway") {
        return {
            fileName: "railway.json",
            mimetype: "application/json",
            buffer: Buffer.from(makeRailwayFile(prompt), "utf8"),
            caption: "File railway.json sudah dibuat. Taruh di root project sebelum deploy ke Railway.",
        }
    }

    if (type === "github") {
        return {
            fileName: "github-actions-ci.yml",
            mimetype: "text/yaml",
            buffer: Buffer.from(makeGithubWorkflow(prompt), "utf8"),
            caption: "File GitHub Actions workflow sudah dibuat. Letakkan di .github/workflows/ci.yml.",
        }
    }

    if (type === "env") {
        return {
            fileName: ".env.example",
            mimetype: "text/plain",
            buffer: Buffer.from(makeEnvExample(), "utf8"),
            caption: "File .env.example sudah dibuat.",
        }
    }

    if (type === "json") {
        return {
            fileName: `${slug}.json`,
            mimetype: "application/json",
            buffer: Buffer.from(JSON.stringify({ title, createdBy: "Watson", items: [] }, null, 2), "utf8"),
            caption: "File JSON sudah dibuat.",
        }
    }

    if (type === "csv") {
        const csv = "nama,deskripsi,status\nContoh Item,Isi deskripsi di sini,draft\n"
        return {
            fileName: `${slug}.csv`,
            mimetype: "text/csv",
            buffer: Buffer.from(csv, "utf8"),
            caption: "File CSV sudah dibuat.",
        }
    }

    if (type === "code") {
        const file = makeCodeFile(prompt)
        return {
            ...file,
            buffer: Buffer.from(file.content, "utf8"),
            caption: "File kode awal sudah dibuat.",
        }
    }

    if (type === "simulation") {
        return makeRocketSimulationHtml(prompt, pushname)
    }

    const body = await draftContent(prompt, pushname, askText)

    if (type === "pdf") {
        return {
            fileName: `${slug}.pdf`,
            mimetype: "application/pdf",
            buffer: createPdfBuffer(title, body),
            caption: "PDF sudah dibuat dan dikirim.",
        }
    }

    if (type === "docx") {
        return {
            fileName: `${slug}.docx`,
            mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            buffer: createDocxBuffer(title, body),
            caption: "File Microsoft Word (.docx) sudah dibuat dan dikirim.",
        }
    }

    if (type === "html") {
        const html = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeXml(title)}</title></head>
<body><main><pre style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.5">${escapeXml(body)}</pre></main></body>
</html>`
        return {
            fileName: `${slug}.html`,
            mimetype: "text/html",
            buffer: Buffer.from(html, "utf8"),
            caption: "File HTML sudah dibuat.",
        }
    }

    if (type === "markdown") {
        return {
            fileName: `${slug}.md`,
            mimetype: "text/markdown",
            buffer: Buffer.from(`# ${title}\n\n${body}\n`, "utf8"),
            caption: "File Markdown sudah dibuat.",
        }
    }

    return {
        fileName: `${slug}.txt`,
        mimetype: "text/plain",
        buffer: Buffer.from(body, "utf8"),
        caption: "File teks sudah dibuat.",
    }
}

module.exports = {
    buildAgentArtifact,
    detectAgentArtifactRequest,
}
