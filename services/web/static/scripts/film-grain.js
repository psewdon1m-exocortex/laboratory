(function filmGrainBoot() {
  const layers = Array.from(document.querySelectorAll(".noise-layer"));
  if (!layers.length) return;

  const state = layers.map((layer) => {
    const canvas = document.createElement("canvas");
    canvas.className = "noise-canvas";
    layer.appendChild(canvas);
    return {
      layer,
      canvas,
      ctx: canvas.getContext("2d", { alpha: true })
    };
  });

  const textureCanvas = document.createElement("canvas");
  const textureCtx = textureCanvas.getContext("2d", { alpha: false });
  let config = { intensity: 35, grain: 55 };
  let texW = 320;
  let texH = 200;
  let textureData = null;

  let seed = 987654321;
  const rnd = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  function rebuildTexture() {
    const g = Math.max(0, Math.min(100, Number(config.grain) || 55));
    texW = Math.round(760 - g * 5.2); // higher grain => bigger visual particles
    texH = Math.round((texW * 10) / 16);
    textureCanvas.width = texW;
    textureCanvas.height = texH;
    textureData = textureCtx.createImageData(texW, texH);
  }

  function updateConfig(next) {
    if (!next) return;
    config = {
      intensity: Math.max(0, Math.min(100, Number(next.intensity) || 35)),
      grain: Math.max(0, Math.min(100, Number(next.grain) || 55))
    };
    rebuildTexture();
  }

  function resizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    state.forEach(({ canvas, layer }) => {
      const rect = layer.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    });
  }

  function renderTexture() {
    const data = textureData.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = Math.floor(96 + rnd() * 80); // slightly wider grain chunks
      const speck = rnd() > 0.98 ? (rnd() > 0.5 ? 34 : -34) : 0;
      const v = Math.max(0, Math.min(255, n + speck));
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    textureCtx.putImageData(textureData, 0, 0);
  }

  let lastFrame = 0;
  function frame(ts) {
    if (ts - lastFrame < 70) {
      requestAnimationFrame(frame);
      return;
    }
    lastFrame = ts;
    renderTexture();

    state.forEach(({ layer, canvas, ctx }) => {
      if (!layer.classList.contains("enabled")) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const intensityRatio = config.intensity / 100;
      const layerOpacity = 0.03 + intensityRatio * 0.3;
      layer.style.opacity = String(layerOpacity);
      const flicker = 0.02 + intensityRatio * 0.12 + rnd() * 0.04;
      ctx.save();
      ctx.globalAlpha = flicker;
      ctx.imageSmoothingEnabled = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(textureCanvas, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    });

    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resizeCanvases);
  window.addEventListener("noise-config-change", (ev) => {
    updateConfig(ev.detail || {});
  });
  updateConfig(window.__noiseConfig || config);
  resizeCanvases();
  requestAnimationFrame(frame);
})();
