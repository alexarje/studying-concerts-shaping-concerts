// Animations of concert data for the keynote. The framework (canvas set-up, start on slide, final frame
// in the PDF, theme redraw, L for sound) is copied from the colloquium's lib/standstill.js of 16 November
// 2026; the animations are new. The data are in images/concert.js, written by tools/make_concert_traces.py
// from the MusicLab Copenhagen Dataset (osf.io/v9wa4, CC BY 4.0). Each <canvas data-anim="..."> is drawn
// when its slide is shown; data-speed is data seconds per real second. With ?fragments=false (the PDF)
// the final frame is drawn at once. Colours are read from the CSS variables, so dark mode follows.
//
// Sound and interaction (17 November 2026), all synthesised with Web Audio from the data, offline:
//   L  sound on or off for the animation on the current slide
//   R  replay the animation
//   M  next sonification mapping (loudness, pitch, rhythm) on a slide with a .mapping row
//   click a seating zone (hall, overview): hear only that zone; click again to add or remove zones;
//      a click outside the zones hears the whole hall again
//   drag on the whole-concert line (overview): move the playhead; the sweep goes on from there
//   click a musician (hearts): mute or unmute that heart
(function () {
  var C = window.CONCERT;
  if (!C) return;
  var STATIC = /[?&]fragments=false\b/.test(location.search);
  var FONT = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

  function css(name, fb) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  }
  function col() {
    return { ink: css('--r-main-color', '#363644'), accent: css('--accent', '#5a4fcf'),
             muted: css('--muted', '#718096'), purple: css('--mm-purple', '#A7A1F4'), green: css('--good', '#2f855a'),
             tint: css('--mm-green', '#C1F7AE') };
  }
  function mmss(s) { var neg = s < 0; s = Math.abs(Math.floor(s)); var m = Math.floor(s / 60); return (neg ? '−' : '') + m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }

  function setup(c) {
    var W = +c.getAttribute('width'), H = +c.getAttribute('height'), dpr = 2;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    return { c: c, ctx: ctx, W: W, H: H, t: 0, cur: 0, sel: {} };
  }
  function clear(s) { s.ctx.clearRect(0, 0, s.W, s.H); s.cur = 0; }
  function label(ctx, text, x, y, size, color, align, base, bold) {
    ctx.fillStyle = color; ctx.font = (bold ? '700 ' : '') + size + 'px ' + FONT;
    ctx.textAlign = align || 'left'; ctx.textBaseline = base || 'alphabetic'; ctx.fillText(text, x, y);
  }
  function anySel(s) { for (var k in s.sel) if (s.sel[k]) return true; return false; }
  function zoneOn(s, z) { return !anySel(s) || !!s.sel[z]; }
  // Squash relative motion (1 = a person's typical motion during music, applause about ten) into 0..1.
  function squash(v) { return v === null || v === undefined ? 0 : Math.min(1, Math.log(1 + v) / Math.log(1 + 12)); }

  // Six zone boxes in a rectangle: front 1-2, middle 3-4, back 5-6; odd numbers stage left, which is
  // the audience's right, drawn on the right as the audience sees it.
  function zoneBoxes(box, gap) {
    var zw = box.w / 2 - gap / 2, zh = (box.h - 2 * gap) / 3, out = [];
    for (var z = 1; z <= 6; z++) {
      var row = Math.floor((z - 1) / 2), right = (z % 2) === 1;
      out.push({ z: z, x: box.x + (right ? box.w / 2 + gap / 2 : 0), y: box.y + row * (zh + gap), w: zw, h: zh });
    }
    return out;
  }
  // Seat positions within the zones. Within a zone, people are placed on a grid in data order, which
  // carries no information about where they sat.
  function seats(s, box) {
    var pos = [], byZone = {};
    C.hall.zone.forEach(function (z, j) { (byZone[z] = byZone[z] || []).push(j); });
    s.zones = zoneBoxes(box, 40);
    s.zones.forEach(function (Z) {
      var list = byZone[Z.z] || [], n = list.length, cols = Math.max(1, Math.ceil(Math.sqrt(n * Z.w / Z.h))), rows = Math.max(1, Math.ceil(n / cols));
      list.forEach(function (j, k) {
        pos[j] = { x: Z.x + (k % cols + 0.5) * Z.w / cols, y: Z.y + (Math.floor(k / cols) + 0.5) * Z.h / rows, r: 0.48 * Math.min(Z.w / cols, Z.h / rows, 70) };
      });
    });
    return pos;
  }
  function drawZoneFrames(s, k, zones, labels) {
    var ctx = s.ctx;
    zones.forEach(function (Z) {
      var picked = anySel(s) && s.sel[Z.z];
      if (picked) { ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = k.accent; ctx.fillRect(Z.x, Z.y, Z.w, Z.h); ctx.restore(); }
      ctx.save(); ctx.globalAlpha = picked ? 1 : 0.35; ctx.strokeStyle = picked ? k.accent : k.muted; ctx.lineWidth = picked ? 4 : 2;
      ctx.strokeRect(Z.x, Z.y, Z.w, Z.h); ctx.restore();
      if (labels) label(ctx, labels(Z), Z.x + 8, Z.y + 26, 23, picked ? k.accent : k.muted, 'left', 'alphabetic', picked);
    });
  }

  var ANIMS = {
    // The audience in the hall, one dot per person, the size and colour following each person's motion
    // relative to their own median during music; the shared line below is the mean.
    hall: {
      duration: function () { return (C.hall.q[0].length - 1) * C.hall.dt; },
      still: function () { return C.hall.clap_start + 8 - C.hall.t0; },     // the PDF shows the applause
      init: function (s) {
        s.stage = { x: 360, y: 70, w: s.W - 720, h: 40 };
        s.box = { x: 360, y: 130, w: s.W - 720, h: s.H - 370 };
        s.pos = seats(s, s.box);
        var n = C.hall.q[0].length; s.mean = []; s.zmean = [[], [], [], [], [], []];
        var cnt = [0, 0, 0, 0, 0, 0]; C.hall.zone.forEach(function (z) { cnt[z - 1]++; });
        for (var i = 0; i < n; i++) {
          var sum = 0, zs = [0, 0, 0, 0, 0, 0];
          C.hall.q.forEach(function (r, j) { sum += r[i]; zs[C.hall.zone[j] - 1] += r[i]; });
          s.mean.push(sum / C.hall.q.length);
          for (var z = 0; z < 6; z++) s.zmean[z].push(cnt[z] ? zs[z] / cnt[z] : 0);
        }
        s.max = Math.max.apply(null, s.mean);
        s.plot = { x: 120, y: s.H - 200, w: s.W - 240, h: 150 };
      },
      values: function (s, t) {          // per zone, for the sound
        var i = Math.min(s.mean.length - 1, Math.floor(t / C.hall.dt));
        return s.zmean.map(function (zm) { return zm[i]; });
      },
      hit: function (s, x, y) {           // a click on a zone
        for (var q = 0; q < s.zones.length; q++) { var Z = s.zones[q]; if (x >= Z.x && x <= Z.x + Z.w && y >= Z.y && y <= Z.y + Z.h) return { zone: Z.z }; }
        return { none: true };
      },
      draw: function (s, t) {
        var k = col(), ctx = s.ctx, H = C.hall, i = Math.min(H.q[0].length - 1, Math.floor(t / H.dt)), tc = H.t0 + t;
        clear(s);
        ctx.fillStyle = k.tint; ctx.fillRect(s.stage.x, s.stage.y, s.stage.w, s.stage.h);
        label(ctx, 'stage', s.W / 2, s.stage.y + s.stage.h / 2, 28, '#363644', 'center', 'middle');
        drawZoneFrames(s, k, s.zones, null);
        H.q.forEach(function (r, j) {
          var v = r[i], p = s.pos[j], rad = p.r * (0.25 + 0.75 * squash(v));   // never larger than the person's cell
          ctx.globalAlpha = (0.25 + 0.75 * Math.min(1, v / 6)) * (zoneOn(s, H.zone[j]) ? 1 : 0.3);
          ctx.fillStyle = v > 2 ? k.accent : k.ink;
          ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 2 * Math.PI); ctx.fill();
        });
        ctx.globalAlpha = 1;
        var what = tc < H.music_end ? 'Beethoven, last movement' : tc < H.clap_start ? 'the last chord fades' : tc < H.clap_end ? 'applause' : 'after the applause';
        label(ctx, what, 20, 28, 38, k.ink, 'left', 'middle', true);
        label(ctx, mmss(t), s.W - 20, 28, 38, k.muted, 'right', 'middle', true);
        var p = s.plot, n = s.mean.length;
        function X(q) { return p.x + p.w * q / (n - 1); }
        function Y(v) { return p.y + p.h - p.h * v / s.max; }
        var a0 = (H.clap_start - H.t0) / H.dt, a1 = (H.clap_end - H.t0) / H.dt;
        ctx.fillStyle = k.tint; ctx.globalAlpha = 0.45; ctx.fillRect(X(a0), p.y, X(a1) - X(a0), p.h); ctx.globalAlpha = 1;
        ctx.strokeStyle = k.muted; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y + p.h); ctx.lineTo(p.x + p.w, p.y + p.h); ctx.stroke();
        label(ctx, anySel(s) ? 'the chosen zones' : 'the whole audience', p.x, p.y - 12, 26, k.muted, 'left');
        label(ctx, 'applause', X((a0 + a1) / 2), p.y - 12, 26, k.muted, 'center');
        var series = s.mean;
        if (anySel(s)) {
          series = s.mean.map(function (_, q) { var a = 0, m = 0; for (var z = 1; z <= 6; z++) if (s.sel[z]) { a += s.zmean[z - 1][q]; m++; } return a / m; });
        }
        ctx.strokeStyle = k.accent; ctx.lineWidth = 5; ctx.beginPath();
        for (var q = 0; q <= i; q++) { var yv = Math.min(series[q], s.max); if (q === 0) ctx.moveTo(X(q), Y(yv)); else ctx.lineTo(X(q), Y(yv)); }
        ctx.stroke();
      }
    },
    // The whole concert: the audience's median motion per 5 s, drawn left to right over the segments,
    // with the six seating zones beside it. Clicking zones shows and plays those zones only; dragging on
    // the plot moves the playhead.
    overview: {
      duration: function () { var O = C.overview; return (O.q.length - 1) * O.dt; },
      init: function (s) {
        var O = C.overview, m = 0;
        O.q.forEach(function (v) { if (v !== null && v > m) m = v; });
        s.max = Math.min(m, 12);
        s.hallbox = { x: 20, y: 150, w: 330, h: s.H - 330 };
        s.zones = zoneBoxes(s.hallbox, 16);
        s.plot = { x: 420, y: 120, w: s.W - 460, h: s.H - 260 };
      },
      values: function (s, t) {
        var O = C.overview, i = Math.max(0, Math.min(O.q.length - 1, Math.floor(t / O.dt)));
        return O.zq.map(function (z) { return z[i]; });
      },
      hit: function (s, x, y) {
        for (var q = 0; q < s.zones.length; q++) { var Z = s.zones[q]; if (x >= Z.x && x <= Z.x + Z.w && y >= Z.y && y <= Z.y + Z.h) return { zone: Z.z }; }
        var p = s.plot;
        if (x >= p.x && x <= p.x + p.w && y >= p.y - 40 && y <= p.y + p.h) return { seek: (x - p.x) / p.w * this.duration() };
        return { none: true };
      },
      draw: function (s, t) {
        var k = col(), ctx = s.ctx, O = C.overview, p = s.plot, T = (O.q.length - 1) * O.dt;
        function X(tc) { return p.x + p.w * (tc - O.t0) / T; }
        function Y(v) { return p.y + p.h - p.h * Math.min(v, s.max) / s.max; }
        clear(s);
        var colours = { Music: k.purple, Applause: k.tint, Speech: k.muted, Survey: k.muted };
        O.segs.forEach(function (g) {
          ctx.globalAlpha = g.type === 'Music' ? 0.35 : g.type === 'Applause' ? 0.7 : 0.15;
          ctx.fillStyle = colours[g.type]; ctx.fillRect(X(g.t), p.y, X(g.t + g.d) - X(g.t), p.h);
        });
        ctx.globalAlpha = 1;
        ['Beethoven', 'Schnittke', 'Bach', 'Folk'].forEach(function (name) {
          var g = O.segs.filter(function (x) { return x.name.indexOf(name) === 0; })[0];
          if (g) label(ctx, name, X(g.t) + 6, p.y - 16, 30, k.ink, 'left', 'alphabetic', true);
        });
        // the zones, as a small plan of the hall
        ctx.fillStyle = k.tint; ctx.fillRect(s.hallbox.x, s.hallbox.y - 50, s.hallbox.w, 30);
        label(ctx, 'stage', s.hallbox.x + s.hallbox.w / 2, s.hallbox.y - 35, 22, '#363644', 'center', 'middle');
        drawZoneFrames(s, k, s.zones, function (Z) { return 'zone ' + Z.z + ' · ' + O.zn[Z.z - 1]; });
        var n = Math.min(O.q.length, Math.floor(t / O.dt) + 1);
        function trace(arr, colour, width) {
          ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.beginPath(); var pen = false;
          for (var i = 0; i < n; i++) {
            var v = arr[i];
            if (v === null || v === undefined) { pen = false; continue; }
            if (pen) ctx.lineTo(X(O.t0 + i * O.dt), Y(v)); else { ctx.moveTo(X(O.t0 + i * O.dt), Y(v)); pen = true; }
          }
          ctx.stroke();
        }
        if (anySel(s)) {
          var picked = O.q.map(function (_, i) { var a = 0, m = 0; for (var z = 1; z <= 6; z++) if (s.sel[z] && O.zq[z - 1][i] !== null) { a += O.zq[z - 1][i]; m++; } return m ? a / m : null; });
          ctx.save(); ctx.globalAlpha = 0.35; trace(O.q, k.ink, 2); ctx.restore();
          trace(picked, k.accent, 4);
        } else trace(O.q, k.ink, 3);
        // the playhead, while the line is being drawn or after a drag
        if (!STATIC && t > 0 && t < T) {
          var xh = X(O.t0 + t), seg = O.segs.filter(function (g) { return O.t0 + t >= g.t && O.t0 + t < g.t + g.d; })[0];
          ctx.strokeStyle = k.accent; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(xh, p.y); ctx.lineTo(xh, p.y + p.h); ctx.stroke();
          label(ctx, (seg ? seg.name + ' · ' : '') + mmss(O.t0 + t), Math.min(xh + 10, p.x + p.w - 360), p.y + 30, 26, k.accent, 'left', 'alphabetic', true);
        }
        ctx.fillStyle = k.purple; ctx.globalAlpha = 0.6; ctx.fillRect(p.x, s.H - 60, 40, 30); ctx.globalAlpha = 1;
        label(ctx, 'music', p.x + 52, s.H - 45, 28, k.ink, 'left', 'middle');
        ctx.fillStyle = k.tint; ctx.fillRect(p.x + 200, s.H - 60, 40, 30);
        label(ctx, 'applause', p.x + 252, s.H - 45, 28, k.ink, 'left', 'middle');
        ctx.fillStyle = k.muted; ctx.globalAlpha = 0.3; ctx.fillRect(p.x + 430, s.H - 60, 40, 30); ctx.globalAlpha = 1;
        label(ctx, 'speech and surveys', p.x + 482, s.H - 45, 28, k.ink, 'left', 'middle');
        label(ctx, 'audience motion, median', p.x + p.w, s.H - 45, 28, k.muted, 'right', 'middle');
      }
    },
    // Three hearts in the quartet: a dot that lights at every beat and the heart rate scrolling past.
    hearts: {
      duration: function () { return C.hearts.end - C.hearts.start; },
      still: function () { return C.hearts.music_end - 5 - C.hearts.start; },   // the PDF shows the end of the tune
      init: function (s) {
        s.rows = C.hearts.beats.map(function (b) {
          var hr = [];
          for (var i = 1; i < b.length; i++) hr.push([b[i], 60 / (b[i] - b[i - 1])]);
          return hr;
        });
        s.lo = 50; s.hi = 130; s.mute = {};
      },
      hit: function (s, x, y) {
        var rowH = (s.H - 90) / s.rows.length;
        if (x < 400) { var j = Math.floor((y - 70) / rowH); if (j >= 0 && j < s.rows.length) return { musician: j }; }
        return { none: true };
      },
      draw: function (s, t) {
        var k = col(), ctx = s.ctx, Hh = C.hearts, tc = Hh.start + t, win = 30, x0 = 420, x1 = s.W - 40, n = s.rows.length;
        var rowH = (s.H - 90) / n;
        clear(s);
        var what = tc < 0 ? 'before the tune' : tc < Hh.music_end ? 'folk tune, ' + mmss(tc) : tc < Hh.clap_end ? 'applause' : 'after the applause';
        label(ctx, what, x1, 30, 36, k.muted, 'right', 'middle', true);
        s.rows.forEach(function (hr, j) {
          var y0 = 70 + j * rowH, yb = y0 + rowH - 20, beats = Hh.beats[j], muted = !!s.mute[j];
          function X(tt) { return x0 + (x1 - x0) * (tt - (tc - win)) / win; }
          function Y(v) { return yb - (rowH - 40) * (Math.max(s.lo, Math.min(s.hi, v)) - s.lo) / (s.hi - s.lo); }
          var last = -1e9; for (var q = 0; q < beats.length && beats[q] <= tc; q++) last = beats[q];
          var on = tc - last < 0.15 && !STATIC;
          ctx.fillStyle = on ? k.accent : k.purple; ctx.globalAlpha = (on ? 1 : 0.45) * (muted ? 0.35 : 1);
          ctx.beginPath(); ctx.arc(70, y0 + rowH / 2 - 10, on ? 44 : 36, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1;
          label(ctx, 'musician ' + (j + 1) + (muted ? ' (muted)' : ''), 140, y0 + rowH / 2 - 10, 32, muted ? k.muted : k.ink, 'left', 'middle', true);
          ctx.strokeStyle = k.accent; ctx.lineWidth = 4; ctx.beginPath(); var pen = false;
          hr.forEach(function (pt) {
            if (pt[0] > tc || pt[0] < tc - win) return;
            if (pen) ctx.lineTo(X(pt[0]), Y(pt[1])); else { ctx.moveTo(X(pt[0]), Y(pt[1])); pen = true; }
          });
          ctx.stroke();
          ctx.save(); ctx.globalAlpha = 0.3; ctx.strokeStyle = k.muted; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x0, yb); ctx.lineTo(x1, yb); ctx.stroke(); ctx.restore();
        });
        label(ctx, 'heart rate, ' + s.lo + '–' + s.hi + ' beats per minute, the last ' + win + ' seconds', x1, s.H - 10, 26, k.muted, 'right');
      }
    }
  };

  // ---- Sonification ----
  var AC = null, master = null, soundOn = false;
  function audio() {
    if (!AC) {
      AC = new (window.AudioContext || window.webkitAudioContext)(); master = AC.createGain(); master.gain.value = 0.6;
      var lim = AC.createDynamicsCompressor();
      lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.15;
      master.connect(lim); lim.connect(AC.destination);
    }
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function panner(pan) {
    if (!AC.createStereoPanner) return null;
    var p = AC.createStereoPanner(); p.pan.value = pan || 0; return p;
  }
  function blip(freq, dur, vol, pan, type) {
    var o = AC.createOscillator(), g = AC.createGain(), t = AC.currentTime, p = panner(pan);
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); if (p) { g.connect(p); p.connect(master); } else g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  var NOISE = null;
  function noiseBuffer() {
    if (NOISE) return NOISE;
    NOISE = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
    var d = NOISE.getChannelData(0); for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return NOISE;
  }
  function set(param, v, tc) { param.setTargetAtTime(v, AC.currentTime, tc || 0.03); }

  // Six voices, one per seating zone: a pitch from a pentatonic scale (front zones highest) and a side
  // (odd zones to the right, as the zones are drawn). Three mappings of the zone's motion:
  //   loudness  band-passed noise, louder with more motion (a rush, like the hall itself)
  //   pitch     a soft tone that rises with more motion, up to an octave and a half
  //   rhythm    clicks whose rate follows the motion, from one to ten a second
  var ZF = [523.25, 440, 392, 329.63, 293.66, 261.63], MAPS = ['loudness', 'pitch', 'rhythm'];
  function zonePan(z) { return (z % 2 === 1 ? 0.6 : -0.6); }
  function Zones() {
    var vs = [];
    for (var z = 1; z <= 6; z++) {
      var out = AC.createGain(), p = panner(zonePan(z)); out.gain.value = 0;
      if (p) { out.connect(p); p.connect(master); } else out.connect(master);
      var src = AC.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true;
      var bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = ZF[z - 1] * 2; bp.Q.value = 3;
      var ng = AC.createGain(); ng.gain.value = 0; src.connect(bp); bp.connect(ng); ng.connect(out); src.start();
      var o = AC.createOscillator(); o.type = 'triangle'; o.frequency.value = ZF[z - 1] / 2;
      var og = AC.createGain(); og.gain.value = 0; o.connect(og); og.connect(out); o.start();
      vs.push({ z: z, out: out, src: src, ng: ng, o: o, og: og, phase: 0 });
    }
    return { vs: vs, last: AC.currentTime };
  }
  function zonesFrame(Z, vals, sel, mapping) {
    var now = AC.currentTime, dt = Math.min(0.1, now - Z.last); Z.last = now;
    var any = false; for (var k in sel) if (sel[k]) any = true;
    Z.vs.forEach(function (v) {
      var on = !any || sel[v.z], x = on ? squash(vals[v.z - 1]) : 0;
      set(v.out.gain, on ? 1 : 0, 0.05);
      set(v.ng.gain, mapping === 'loudness' ? 1.4 * Math.pow(x, 1.5) : 0, 0.05);
      set(v.og.gain, mapping === 'pitch' && on ? 0.05 + 0.08 * x : 0, 0.05);
      set(v.o.frequency, ZF[v.z - 1] / 2 * Math.pow(2, 1.5 * x), 0.04);
      if (mapping === 'rhythm' && on) {
        v.phase += dt * (1 + 9 * x);
        if (v.phase >= 1) { v.phase -= Math.floor(v.phase); blip(ZF[v.z - 1] * 2, 0.05, 0.25, zonePan(v.z), 'square'); }
      }
    });
  }
  function zonesStop(Z) {
    Z.vs.forEach(function (v) {
      try { set(v.out.gain, 0, 0.02); v.src.stop(AC.currentTime + 0.15); v.o.stop(AC.currentTime + 0.15); } catch (e) {}
    });
  }
  function mappingOf(s) {
    var sl = s.c.closest('section'), row = sl && sl.querySelector('.mapping');
    return row ? (row.getAttribute('data-map') || 'loudness') : 'loudness';
  }

  var SOUND = {
    // The hall and the whole concert: the six zones as six voices, in the slide's mapping.
    hall: {
      start: function (s) { s.snd = Zones(); },
      frame: function (s, t) { zonesFrame(s.snd, s.anim.values(s, t), s.sel, mappingOf(s)); },
      stop: function (s) { zonesStop(s.snd); s.snd = null; }
    },
    overview: {
      start: function (s) { s.snd = Zones(); },
      frame: function (s, t) { zonesFrame(s.snd, s.anim.values(s, t), s.sel, mappingOf(s)); },
      stop: function (s) { zonesStop(s.snd); s.snd = null; }
    },
    // The hearts: one soft thud per beat, a different pitch and side for each musician.
    hearts: {
      start: function (s) { s.snd = { next: C.hearts.beats.map(function () { return 0; }) }; },
      frame: function (s, t) {
        var tc = C.hearts.start + t;
        C.hearts.beats.forEach(function (b, j) {
          while (s.snd.next[j] < b.length && b[s.snd.next[j]] <= tc) {
            if (tc - b[s.snd.next[j]] < 0.2 && !s.mute[j]) blip([65, 98, 82][j % 3], 0.16, 0.4, [-0.7, 0, 0.7][j % 3]);
            s.snd.next[j]++;
          }
        });
      },
      seek: function (s) { s.snd.next = C.hearts.beats.map(function () { return 0; }); },
      stop: function (s) { s.snd = null; }
    }
  };
  function soundStart(s) { var k = s.c.getAttribute('data-anim'); if (SOUND[k] && !s.snd) { audio(); SOUND[k].start(s); } }
  function soundStop(s) { var k = s.c.getAttribute('data-anim'); if (SOUND[k] && s.snd) SOUND[k].stop(s); }
  function soundFrame(s) { var k = s.c.getAttribute('data-anim'); if (soundOn && s.snd && SOUND[k]) SOUND[k].frame(s, s.t); }
  function status() {
    var el = document.getElementById('sound'); if (!el) return;
    var cur = revealRef && revealRef.getCurrentSlide(), row = cur && cur.querySelector('.mapping');
    el.textContent = soundOn ? '♪ sound' + (row ? ' · ' + (row.getAttribute('data-map') || 'loudness') : '') : '';
  }
  function setSound(on, Reveal) {
    soundOn = on;
    var cur = Reveal.getCurrentSlide();
    states.forEach(function (s) { if (on && cur && cur.contains(s.c) && (s.raf || s.hold)) soundStart(s); else soundStop(s); });
    status();
  }

  var states = [];
  function state(c) {
    for (var i = 0; i < states.length; i++) if (states[i].c === c) return states[i];
    var s = setup(c), a = ANIMS[c.getAttribute('data-anim')];
    s.anim = a; s.speed = +(c.getAttribute('data-speed') || 1); a.init(s); states.push(s);
    if (!STATIC) wire(s);
    return s;
  }
  function redraw(s) { clear(s); s.anim.draw(s, s.t); }
  function stop(s) { if (s.raf) cancelAnimationFrame(s.raf); s.raf = null; s.hold = false; if (s.snd) soundStop(s); }
  // Runs the animation from data time `from` (0 by default) to the end.
  function start(s, from) {
    if (s.raf) cancelAnimationFrame(s.raf); s.raf = null;
    s.t = from || 0; if (!from) clear(s);
    var k = s.c.getAttribute('data-anim');
    if (s.snd && SOUND[k] && SOUND[k].seek) SOUND[k].seek(s);
    var dur = s.anim.duration(), t0 = null, base = s.t;
    function frame(now) {
      if (t0 === null) t0 = now;
      var t = base + ((now - t0) / 1000) * s.speed;
      s.t = Math.min(t, dur); s.anim.draw(s, s.t);
      if (soundOn && !s.snd) soundStart(s);
      soundFrame(s);
      if (t < dur) s.raf = requestAnimationFrame(frame); else { s.raf = null; soundStop(s); }
    }
    s.raf = requestAnimationFrame(frame);
  }
  function finish(s) { stop(s); s.t = s.anim.still ? s.anim.still() : s.anim.duration(); redraw(s); }

  // Pointer interaction on a canvas: zones, the playhead and the musicians.
  function wire(s) {
    var c = s.c, a = s.anim;
    if (!a.hit) return;
    c.style.cursor = 'pointer'; c.style.touchAction = 'none';
    function pos(ev) {
      var r = c.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * s.W / r.width, y: (ev.clientY - r.top) * s.H / r.height };
    }
    function seek(ev) {
      var p = pos(ev), h = a.hit(s, p.x, p.y);
      if (h.seek === undefined) return;
      if (s.raf) cancelAnimationFrame(s.raf); s.raf = null; s.hold = true;
      s.t = Math.max(0, Math.min(a.duration(), h.seek)); redraw(s);
      if (soundOn) { soundStart(s); soundFrame(s); }
    }
    c.addEventListener('pointerdown', function (ev) {
      var p = pos(ev), h = a.hit(s, p.x, p.y);
      ev.stopPropagation();
      if (h.zone) { s.sel[h.zone] = !s.sel[h.zone]; redraw(s); }
      else if (h.musician !== undefined) { s.mute[h.musician] = !s.mute[h.musician]; redraw(s); }
      else if (h.seek !== undefined) { s.drag = true; try { c.setPointerCapture(ev.pointerId); } catch (e) {} seek(ev); }
      else { s.sel = {}; redraw(s); }
    });
    c.addEventListener('pointermove', function (ev) { if (s.drag) seek(ev); });
    function up() { if (!s.drag) return; s.drag = false; start(s, s.t); }   // the sweep goes on from the playhead
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }

  // The mapping buttons: <div class="mapping"><button data-map="loudness">... in the slide; M cycles them.
  function setMapping(row, m) {
    row.setAttribute('data-map', m);
    row.querySelectorAll('button[data-map]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-map') === m); });
    status();
  }
  function wireMappings() {
    document.querySelectorAll('.mapping').forEach(function (row) {
      setMapping(row, row.getAttribute('data-map') || 'loudness');
      row.querySelectorAll('button[data-map]').forEach(function (b) {
        b.addEventListener('click', function (ev) { ev.stopPropagation(); setMapping(row, b.getAttribute('data-map')); b.blur(); });
      });
    });
  }

  var revealRef = null;
  window.Concert = {
    sound: function (on) { if (revealRef) setSound(on, revealRef); return soundOn; },
    state: function (c) { return state(c); },          // for tests
    audio: function () { return AC; },                 // for tests
    init: function (Reveal) {
      revealRef = Reveal;
      var all = Array.prototype.slice.call(document.querySelectorAll('canvas[data-anim]'));
      if (STATIC) { all.forEach(function (c) { finish(state(c)); }); return; }
      wireMappings();
      function onSlide() {
        var cur = Reveal.getCurrentSlide();
        all.forEach(function (c) {
          var s = state(c);
          var waits = c.classList.contains('fragment') && !c.classList.contains('visible');
          if (cur && cur.contains(c) && !waits) { if (!s.raf && !s.hold) start(s); } else { stop(s); if (waits) clear(s); }
        });
        status();
      }
      Reveal.on('ready', onSlide);
      Reveal.on('fragmentshown', function (e) { if (e.fragment && e.fragment.matches && e.fragment.matches('canvas[data-anim]')) start(state(e.fragment)); });
      Reveal.on('fragmenthidden', function (e) { if (e.fragment && e.fragment.matches && e.fragment.matches('canvas[data-anim]')) { var s = state(e.fragment); stop(s); clear(s); } });
      Reveal.on('slidechanged', function () { setSound(false, Reveal); onSlide(); });
      Reveal.addKeyBinding({ keyCode: 76, key: 'L', description: 'Sound on/off for the animation' }, function () { setSound(!soundOn, Reveal); });
      Reveal.addKeyBinding({ keyCode: 82, key: 'R', description: 'Replay the animation' }, function () {
        var cur = Reveal.getCurrentSlide(); all.forEach(function (c) { if (cur && cur.contains(c)) { var s = state(c); s.hold = false; start(s); } });
      });
      Reveal.addKeyBinding({ keyCode: 77, key: 'M', description: 'Next sonification mapping' }, function () {
        var cur = Reveal.getCurrentSlide(), row = cur && cur.querySelector('.mapping');
        if (row) setMapping(row, MAPS[(MAPS.indexOf(row.getAttribute('data-map')) + 1) % MAPS.length]);
      });
      document.addEventListener('themechange', function () { states.forEach(redraw); });
    }
  };
})();
