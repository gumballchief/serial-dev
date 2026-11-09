/* Serial Dev landing page.
   The hero chalkboard is a serial dev's tally wall: every coin launched on pump.fun right now,
   read live off Solana, adds a chalk mark. */
(() => {
  const REPO = "https://github.com/gumballchief/serial-dev";
  const LINKS = { repo: REPO, playbook: `${REPO}/blob/main/PLAYBOOK.md`, docs: `${REPO}#readme` };
  document.querySelectorAll("[data-link]").forEach((a) => {
    a.href = LINKS[a.dataset.link] || REPO;
    a.target = "_blank";
    a.rel = "noopener";
  });

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = typeof window.gsap !== "undefined";
  const nav = document.querySelector(".nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------------- Tally wall ---------------- */
  const board = document.querySelector(".board");
  const canvas = document.querySelector(".wall");
  const ctx = canvas.getContext("2d");
  const dev = document.querySelector(".hero-dev");
  let W = 0, H = 0, U = 40, zone = null, liveMarks = 0;
  const rand = (a, b) => a + Math.random() * (b - a);

  // One chalk stroke: a few rough passes with gaps, so it reads as chalk grain, not a vector line.
  function chalkLine(x1, y1, x2, y2, w, alpha = 0.85, from = 0, to = 1) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(6, Math.round(len / 2));
    const s0 = Math.floor(from * steps), s1 = Math.ceil(to * steps);
    ctx.lineCap = "round";
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      ctx.strokeStyle = `rgba(236,235,228,${alpha * rand(0.32, 0.7)})`;
      ctx.lineWidth = w * rand(0.5, 1.05);
      const ox = rand(-0.3, 0.3) * w, oy = rand(-0.3, 0.3) * w;
      let down = false;
      for (let i = s0; i <= s1; i++) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t + ox + rand(-0.12, 0.12) * w;
        const y = y1 + (y2 - y1) * t + oy + rand(-0.12, 0.12) * w;
        if (Math.random() < 0.07) { if (down) { ctx.stroke(); ctx.beginPath(); down = false; } continue; }
        if (!down) { ctx.moveTo(x, y); down = true; } else ctx.lineTo(x, y);
      }
      if (down) ctx.stroke();
    }
  }

  // The 5 strokes of a tally group at (gx, gy), size u. Returns stroke coordinates.
  function groupStrokes(gx, gy, u) {
    const s = [];
    const slant = rand(-0.08, 0.1) * u;
    for (let i = 0; i < 4; i++) {
      const x = gx + i * 0.27 * u + rand(-0.03, 0.03) * u;
      s.push([x + slant, gy + rand(-0.04, 0.04) * u, x, gy + u + rand(-0.05, 0.05) * u]);
    }
    s.push([gx - 0.16 * u, gy + 0.78 * u, gx + 0.98 * u, gy + 0.18 * u]);
    return s;
  }

  function ledgeTop() {
    return document.querySelector(".ledge").getBoundingClientRect().top - board.getBoundingClientRect().top;
  }
  function devHand() {
    const b = board.getBoundingClientRect(), d = dev.getBoundingClientRect();
    return { x: d.right - b.left - d.width * 0.06, y: d.top - b.top + d.height * 0.2, left: d.left - b.left, right: d.right - b.left, top: d.top - b.top };
  }

  function layout() {
    const r = board.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    U = Math.max(22, Math.min(46, W / 42));
    const hand = devHand();
    // The "today" patch right of the chalk hand stays clear for live marks.
    zone = { x: hand.x + 0.7 * U, y: Math.max(hand.y - 0.4 * U, 70), cols: W < 700 ? 3 : 5, rows: 3 };
    zone.w = zone.cols * 1.55 * U;
    zone.h = zone.rows * 1.5 * U;
    if (zone.x + zone.w > W - 8) zone.x = Math.max(hand.left - zone.w - 0.6 * U, 8);
  }

  // Pre-filled wall: every group already struck before you showed up.
  function wallGroups() {
    const groups = [];
    const top = 82, bottom = ledgeTop() - 0.35 * U;
    for (let gy = top; gy < bottom - U; gy += 1.5 * U) {
      for (let gx = 10 + rand(0, 0.6) * U; gx < W - U; gx += 1.55 * U) {
        const x = gx + rand(-0.15, 0.15) * U, y = gy + rand(-0.12, 0.12) * U;
        const inZone = x > zone.x - 0.4 * U && x < zone.x + zone.w && y > zone.y - 0.5 * U && y < zone.y + zone.h;
        if (!inZone && Math.random() > 0.04) groups.push([x, y]);
      }
    }
    return groups;
  }

  function drawWall(animate) {
    ctx.clearRect(0, 0, W, H);
    const groups = wallGroups().sort(() => Math.random() - 0.5);
    const w = Math.max(1.6, U * 0.075);
    const drawGroup = ([x, y]) => groupStrokes(x, y, U).forEach((s) => chalkLine(...s, w, 0.62));
    if (!animate) { groups.forEach(drawGroup); redrawLive(); return; }
    let i = 0;
    const per = Math.max(3, Math.ceil(groups.length / 55));
    const step = () => {
      for (let k = 0; k < per && i < groups.length; k++, i++) drawGroup(groups[i]);
      if (i < groups.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function zoneSpot(n) {
    const per = zone.cols * zone.rows * 5;
    const m = n % per, g = Math.floor(m / 5);
    const gx = zone.x + (g % zone.cols) * 1.55 * U, gy = zone.y + Math.floor(g / zone.cols) * 1.5 * U;
    return { stroke: groupStrokes(gx, gy, U)[m % 5], first: m === 0 };
  }
  function redrawLive() {
    const per = zone.cols * zone.rows * 5;
    const start = Math.floor(liveMarks / per) * per;
    for (let n = start; n < liveMarks; n++) chalkLine(...zoneSpot(n).stroke, Math.max(1.8, U * 0.085), 0.95);
  }

  // A new launch: animate one chalk mark into the today patch and make the dev strike it.
  const queue = [];
  let striking = false;
  function strike() {
    if (striking || !queue.length) return;
    striking = true;
    queue.shift();
    const { stroke, first } = zoneSpot(liveMarks);
    if (first && liveMarks > 0) ctx.clearRect(zone.x - U, zone.y - U, zone.w + 2 * U, zone.h + 2 * U);
    liveMarks++;
    const w = Math.max(1.8, U * 0.085);
    if (hasGsap && !reduce) gsap.fromTo(dev, { rotate: 0, y: 0 }, { rotate: -2.2, y: -8, duration: 0.11, yoyo: true, repeat: 1, ease: "power2.out" });
    const t0 = performance.now(), dur = reduce ? 0 : 260;
    let done = 0;
    const frame = (now) => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1;
      chalkLine(...stroke, w, 0.95, done, p);
      done = p;
      if (p < 1) requestAnimationFrame(frame);
      else { striking = false; setTimeout(strike, 120); }
    };
    requestAnimationFrame(frame);
  }
  function addMark() {
    if (queue.length < 6) queue.push(1);
    strike();
  }

  const start = () => { layout(); drawWall(!reduce); };
  if (dev.complete) start(); else dev.addEventListener("load", start, { once: true });
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { layout(); drawWall(false); }, 200); });

  /* ---------------- Live pump.fun launches (read straight off Solana) ---------------- */
  const live = document.querySelector(".live");
  const liveText = live.querySelector(".live-text");
  const liveCount = live.querySelector(".live-count");
  const liveLast = live.querySelector(".live-last");
  const MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"; // every pump.fun create touches it
  const CREATE = [27, 114, 169, 77, 222, 235, 99, 118];
  const td = new TextDecoder();
  let count = 0, gotOne = false;
  const recent = [];

  function decodeCreate(b64) {
    try {
      const bin = atob(b64);
      if (bin.length < 150) return null;
      const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      for (let i = 0; i < 8; i++) if (u8[i] !== CREATE[i]) return null;
      const dv = new DataView(u8.buffer);
      let o = 8;
      const str = () => { const n = dv.getUint32(o, true); const s = td.decode(u8.subarray(o + 4, o + 4 + n)); o += 4 + n; return s; };
      const name = str(), symbol = str();
      return { name, symbol };
    } catch { return null; }
  }

  function onLaunch(ev) {
    count++;
    gotOne = true;
    live.classList.add("on");
    liveText.textContent = "coins launched on pump.fun since you got here";
    liveCount.textContent = count.toLocaleString();
    const sym = (ev.symbol || ev.name || "").replace(/\s+/g, "").slice(0, 12);
    if (sym) recent.unshift("$" + sym.toUpperCase());
    recent.length = Math.min(recent.length, 3);
    liveLast.textContent = recent.join("   ");
    addMark();
  }

  const ENDPOINTS = ["wss://solana-rpc.publicnode.com", "wss://solana.drpc.org"];
  function connect(attempt = 0) {
    let ws;
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try { ws = new WebSocket(url); } catch { return attempt < ENDPOINTS.length - 1 ? connect(attempt + 1) : fallback(); }
    const giveUp = setTimeout(() => {
      if (gotOne) return;
      ws.close();
      if (attempt < ENDPOINTS.length - 1) connect(attempt + 1); else fallback();
    }, 12000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [MINT_AUTHORITY] }, { commitment: "confirmed" }] }));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      const v = msg.params?.result?.value;
      if (!v || v.err) return;
      for (const line of v.logs || []) {
        if (!line.startsWith("Program data: ")) continue;
        const ev = decodeCreate(line.slice(14));
        if (ev) onLaunch(ev);
      }
    };
    ws.onclose = () => { if (gotOne && attempt < 8) { clearTimeout(giveUp); setTimeout(() => connect(attempt + 1), 3000); } };
    ws.onerror = () => {};
  }
  // If the chain feed can't be reached, say so honestly and keep the wall still.
  function fallback() {
    if (gotOne) return;
    liveText.textContent = "pump.fun launches about 30 coins a minute";
    liveCount.textContent = "";
  }
  connect();

  /* ---------------- Install: tabs + copy ---------------- */
  const tabs = document.querySelectorAll(".tabs button");
  const cmds = document.querySelectorAll(".cmd");
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((b) => b.setAttribute("aria-selected", String(b === t)));
    cmds.forEach((c) => (c.hidden = c.dataset.for !== t.dataset.tab));
  }));
  const copyCmd = async (btn) => {
    const active = [...cmds].find((c) => !c.hidden);
    const text = active.textContent.trim();
    try { await navigator.clipboard.writeText(text); } catch {
      const r = document.createRange(); r.selectNodeContents(active); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); s.removeAllRanges();
    }
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1600);
  };
  document.querySelector(".copy").addEventListener("click", (e) => copyCmd(e.currentTarget));
  document.querySelector(".copy-cta").addEventListener("click", (e) => copyCmd(e.currentTarget));

  /* ---------------- Motion ---------------- */
  if (!hasGsap || reduce) return;
  gsap.registerPlugin(ScrollTrigger);

  // Hero entrance
  gsap.timeline({ defaults: { ease: "power3.out" } })
    .from(".hero-dev", { y: 70, opacity: 0, scale: 0.94, duration: 1 }, 0.15)
    .from(".coin", { y: -160, opacity: 0, rotate: -40, duration: 0.9, stagger: 0.12, ease: "bounce.out" }, 0.35)
    .from(".hero h1 .line", { yPercent: 70, opacity: 0, duration: 0.9, stagger: 0.12 }, 0.3)
    .from(".sub", { y: 20, opacity: 0, duration: 0.7 }, 0.75)
    .from(".hero .ctas .btn", { y: 20, opacity: 0, duration: 0.6, stagger: 0.08 }, 0.85)
    .from(".live", { opacity: 0, duration: 0.6 }, 1.1);
  // Board drifts slower than the page: depth.
  gsap.to(".board", { yPercent: 12, ease: "none", scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true } });

  // How it works: the clock runs 0:00 -> 0:19 -> 0:22 while the cards land.
  const stamps = gsap.utils.toArray(".stamp");
  stamps.forEach((s) => (s.textContent = "0:00"));
  const clock = { t: 0 };
  const showClock = () => {
    const t = Math.round(clock.t);
    stamps.forEach((s) => { if (t >= Number(s.dataset.t)) s.textContent = `0:${String(Number(s.dataset.t)).padStart(2, "0")}`; else s.textContent = `0:${String(t).padStart(2, "0")}`; });
  };
  const line = document.querySelector(".chart .line");
  const L = line.getTotalLength();
  gsap.set(line, { strokeDasharray: L, strokeDashoffset: L });
  gsap.timeline({ scrollTrigger: { trigger: ".steps", start: "top 75%" } })
    .from(".step:nth-child(1) .card", { y: 50, opacity: 0, duration: 0.45, ease: "power3.out" })
    .from(".arrow:nth-child(2)", { scaleX: 0, transformOrigin: "left", duration: 0.3 })
    .from(".step:nth-child(3) .card", { y: 50, opacity: 0, duration: 0.45, ease: "power3.out" }, "<0.1")
    .to(clock, { t: 19, duration: 0.9, ease: "none", onUpdate: showClock }, "<")
    .from(".arrow:nth-child(4)", { scaleX: 0, transformOrigin: "left", duration: 0.3 })
    .from(".step:nth-child(5) .card", { y: 50, opacity: 0, duration: 0.45, ease: "power3.out" }, "<0.1")
    .to(clock, { t: 22, duration: 0.3, ease: "none", onUpdate: showClock }, "<")
    .to(line, { strokeDashoffset: 0, duration: 1, ease: "power2.inOut" })
    .from(".chart .area", { opacity: 0, duration: 0.6 }, "<0.3")
    .from(".caption", { y: 20, opacity: 0, duration: 0.5 }, "<");

  // Sources: strings pull tight, notes get pinned.
  gsap.utils.toArray(".strings line").forEach((l) => { l.setAttribute("pathLength", "1"); gsap.set(l, { strokeDasharray: 1, strokeDashoffset: 1 }); });
  gsap.timeline({ scrollTrigger: { trigger: ".evidence", start: "top 70%" } })
    .from(".note.center", { scale: 0.6, opacity: 0, duration: 0.5, ease: "back.out(2)" })
    .to(".strings line", { strokeDashoffset: 0, duration: 0.7, stagger: 0.08, ease: "power2.out" })
    .from(".note:not(.center)", { y: -60, opacity: 0, rotate: () => gsap.utils.random(-14, 14), duration: 0.7, stagger: 0.1, ease: "back.out(1.6)" }, "<0.15")
    .from(".note .pin", { y: -30, opacity: 0, duration: 0.3, stagger: 0.1, ease: "power2.in" }, "<0.4");
  gsap.from(".sources .side > *", { y: 30, opacity: 0, duration: 0.7, stagger: 0.1, scrollTrigger: { trigger: ".sources .side", start: "top 75%" } });

  // Pictures: dropped onto the table one by one.
  gsap.from(".pol", { y: 120, opacity: 0, rotate: (i) => [-10, 8, -7, 11][i], duration: 0.9, stagger: 0.14, ease: "power3.out", scrollTrigger: { trigger: ".polaroids", start: "top 80%" } });
  gsap.from(".pictures h2, .pictures .label, .pictures-note", { y: 30, opacity: 0, duration: 0.7, stagger: 0.1, scrollTrigger: { trigger: ".pictures", start: "top 70%" } });

  // Numbers: the 24 counts up, the case file slides in.
  const n = document.querySelector(".huge .n");
  const c = { v: 0 };
  gsap.to(c, { v: 24, duration: 1.6, ease: "power2.out", onUpdate: () => (n.textContent = Math.round(c.v)), scrollTrigger: { trigger: ".numbers", start: "top 65%" } });
  gsap.from(".huge", { scale: 0.86, opacity: 0, duration: 1.1, ease: "power3.out", scrollTrigger: { trigger: ".numbers", start: "top 65%" } });
  gsap.from(".row", { x: 60, opacity: 0, duration: 0.6, stagger: 0.1, ease: "power3.out", scrollTrigger: { trigger: ".ledger", start: "top 75%" } });

  // Install: he peeks up over the terminal.
  gsap.from(".peek", { yPercent: 70, duration: 0.9, ease: "back.out(1.4)", scrollTrigger: { trigger: ".terminal-wrap", start: "top 80%" } });
  gsap.from(".install h2, .terminal, .install .ctas", { y: 30, opacity: 0, duration: 0.7, stagger: 0.1, scrollTrigger: { trigger: ".install", start: "top 70%" } });
})();
