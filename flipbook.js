const PDFJS_VERSION = "4.10.38";
const PDFJS_MODULE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
const PDFJS_CMAP_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`;
const PDFJS_FONT_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

document.querySelectorAll("[data-flipbook]").forEach((flipbook) => {
  initializeFlipbook(flipbook).catch((error) => {
    showReaderError(flipbook, error);
  });
});

async function initializeFlipbook(flipbook) {
  const pdfSource = flipbook.dataset.pdfSrc;
  const shell = flipbook.closest(".pdf-viewer-shell") || flipbook;
  const spread = flipbook.querySelector("[data-flipbook-spread]");
  const stage = flipbook.querySelector(".flipbook-stage");
  const slots = Array.from(flipbook.querySelectorAll("[data-page-slot]"));
  const status = flipbook.querySelector("[data-flipbook-status]");
  const pageInput = flipbook.querySelector("[data-flipbook-page]");
  const progress = flipbook.querySelector("[data-flipbook-progress]");
  const totalLabel = flipbook.querySelector("[data-flipbook-total]");
  const zoomSelect = flipbook.querySelector("[data-flipbook-zoom]");
  const fullscreenButton = shell.querySelector("[data-flipbook-fullscreen]");
  const firstButtons = Array.from(flipbook.querySelectorAll("[data-flipbook-first]"));
  const previousButtons = Array.from(flipbook.querySelectorAll("[data-flipbook-prev]"));
  const nextButtons = Array.from(flipbook.querySelectorAll("[data-flipbook-next]"));
  const lastButtons = Array.from(flipbook.querySelectorAll("[data-flipbook-last]"));

  if (!pdfSource || !spread || !stage || slots.length < 2) {
    throw new Error("Missing flipbook markup");
  }

  const pdfjsLib = await import(PDFJS_MODULE_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

  const state = {
    document: null,
    page: 1,
    totalPages: 0,
    zoom: Number(zoomSelect?.value || 1),
    isRendering: false,
    queuedRender: false,
    singlePage: false,
    resizeTimer: 0,
  };

  updateResponsiveMode();
  status.textContent = "Loading publication...";

  const loadingTask = pdfjsLib.getDocument({
    url: pdfSource,
    cMapPacked: true,
    cMapUrl: PDFJS_CMAP_URL,
    standardFontDataUrl: PDFJS_FONT_URL,
  });
  state.document = await loadingTask.promise;
  state.totalPages = state.document.numPages;

  if (pageInput) {
    pageInput.max = String(state.totalPages);
  }

  if (progress) {
    progress.max = String(state.totalPages);
  }

  if (totalLabel) {
    totalLabel.textContent = `of ${state.totalPages}`;
  }

  bindControls();
  await renderSpread();
  flipbook.classList.add("is-ready");
  preloadNeighborPages();

  function bindControls() {
    firstButtons.forEach((button) => {
      button.addEventListener("click", () => goToPage(1, "prev"));
    });

    previousButtons.forEach((button) => {
      button.addEventListener("click", () => goToPage(state.page - getStep(), "prev"));
    });

    nextButtons.forEach((button) => {
      button.addEventListener("click", () => goToPage(state.page + getStep(), "next"));
    });

    lastButtons.forEach((button) => {
      button.addEventListener("click", () => goToPage(getLastSpreadStart(), "next"));
    });

    pageInput?.addEventListener("change", () => {
      const requestedPage = Number(pageInput.value);
      const direction = requestedPage < state.page ? "prev" : "next";
      goToPage(requestedPage, direction);
    });

    pageInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        pageInput.blur();
      }
    });

    progress?.addEventListener("input", () => {
      const requestedPage = Number(progress.value);
      const direction = requestedPage < state.page ? "prev" : "next";
      goToPage(requestedPage, direction);
    });

    zoomSelect?.addEventListener("change", () => {
      state.zoom = Number(zoomSelect.value);
      requestRender();
    });

    stage.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        goToPage(state.page + getStep(), "next");
      }

      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goToPage(state.page - getStep(), "prev");
      }

      if (event.key === "Home") {
        event.preventDefault();
        goToPage(1, "prev");
      }

      if (event.key === "End") {
        event.preventDefault();
        goToPage(getLastSpreadStart(), "next");
      }
    });

    let pointerStart = null;
    stage.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, input, select, a")) return;
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      stage.setPointerCapture?.(event.pointerId);
    });

    stage.addEventListener("pointerup", (event) => {
      if (!pointerStart || pointerStart.id !== event.pointerId) return;
      const dx = event.clientX - pointerStart.x;
      const dy = event.clientY - pointerStart.y;
      pointerStart = null;

      if (Math.abs(dx) < 52 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
      goToPage(state.page + (dx < 0 ? getStep() : -getStep()), dx < 0 ? "next" : "prev");
    });

    if (fullscreenButton && shell.requestFullscreen) {
      fullscreenButton.addEventListener("click", async () => {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await shell.requestFullscreen();
        }
      });

      document.addEventListener("fullscreenchange", () => {
        fullscreenButton.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
        requestRender();
      });
    } else if (fullscreenButton) {
      fullscreenButton.hidden = true;
    }

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => scheduleResizeRender());
      observer.observe(stage);
    }

    window.addEventListener("resize", scheduleResizeRender);
  }

  function scheduleResizeRender() {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(() => {
      const changed = updateResponsiveMode();
      if (changed) {
        state.page = clamp(state.page, 1, getLastSpreadStart());
      }
      requestRender();
    }, 160);
  }

  function updateResponsiveMode() {
    const singlePage = window.matchMedia("(max-width: 760px)").matches;
    const changed = singlePage !== state.singlePage;
    state.singlePage = singlePage;
    flipbook.classList.toggle("single-page", singlePage);
    return changed;
  }

  function getStep() {
    return state.singlePage ? 1 : 2;
  }

  function getLastSpreadStart() {
    if (state.singlePage || state.totalPages <= 1) {
      return state.totalPages || 1;
    }

    return state.totalPages % 2 === 0 ? state.totalPages - 1 : state.totalPages;
  }

  function goToPage(page, direction = "next") {
    const target = clamp(Number(page) || 1, 1, getLastSpreadStart());
    if (target === state.page && !state.queuedRender) {
      updateControls();
      return;
    }

    state.page = target;
    animatePageTurn(direction);
    requestRender();
  }

  function animatePageTurn(direction) {
    spread.classList.remove("is-turning-next", "is-turning-prev");
    spread.classList.add(direction === "prev" ? "is-turning-prev" : "is-turning-next");
    window.setTimeout(() => {
      spread.classList.remove("is-turning-next", "is-turning-prev");
    }, 460);
  }

  function requestRender() {
    if (state.isRendering) {
      state.queuedRender = true;
      return;
    }

    renderSpread()
      .then(() => {
        if (state.queuedRender) {
          state.queuedRender = false;
          requestRender();
        }
      })
      .catch((error) => {
        state.queuedRender = false;
        showReaderError(flipbook, error);
      });
  }

  async function renderSpread() {
    if (!state.document) return;

    state.isRendering = true;
    setNavigationDisabled(true);
    updateControls();

    try {
      const pageNumbers = state.singlePage
        ? [state.page, null]
        : [state.page, state.page + 1 <= state.totalPages ? state.page + 1 : null];

      await Promise.all(slots.map((slot, index) => renderPage(pageNumbers[index], slot)));
      preloadNeighborPages();
    } finally {
      state.isRendering = false;
      updateControls();
      setNavigationDisabled(false);
    }
  }

  async function renderPage(pageNumber, slot) {
    const canvas = slot.querySelector("canvas");
    const label = slot.querySelector("[data-page-label]");

    if (!canvas || !pageNumber || pageNumber > state.totalPages) {
      slot.classList.add("is-empty");
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (label) label.textContent = "";
      return;
    }

    slot.classList.remove("is-empty");
    if (label) label.textContent = `Page ${pageNumber}`;

    const pdfPage = await state.document.getPage(pageNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const slotRect = slot.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const targetWidth = Math.max(220, slotRect.width - 32);
    const targetHeight = Math.max(320, stageRect.height - 88);
    const fitScale = Math.min(targetWidth / baseViewport.width, targetHeight / baseViewport.height);
    const scale = clamp(fitScale * state.zoom, 0.35, 2.4);
    const viewport = pdfPage.getViewport({ scale });
    const outputScale = clamp(window.devicePixelRatio || 1, 1, 2);
    const context = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, viewport.width, viewport.height);

    await pdfPage.render({
      canvasContext: context,
      viewport,
    }).promise;
  }

  function updateControls() {
    const lastStart = getLastSpreadStart();
    const atStart = state.page <= 1;
    const atEnd = state.page >= lastStart;

    if (pageInput) {
      pageInput.value = String(state.page);
      pageInput.max = String(state.totalPages || 1);
    }

    if (progress) {
      progress.value = String(state.page);
      progress.max = String(state.totalPages || 1);
    }

    firstButtons.forEach((button) => {
      button.disabled = atStart || state.isRendering;
    });

    previousButtons.forEach((button) => {
      button.disabled = atStart || state.isRendering;
    });

    nextButtons.forEach((button) => {
      button.disabled = atEnd || state.isRendering;
    });

    lastButtons.forEach((button) => {
      button.disabled = atEnd || state.isRendering;
    });
  }

  function setNavigationDisabled(disabled) {
    [...firstButtons, ...previousButtons, ...nextButtons, ...lastButtons].forEach((button) => {
      button.disabled = disabled;
    });
  }

  function preloadNeighborPages() {
    if (!state.document) return;

    const candidates = [
      state.page - getStep(),
      state.page + getStep(),
      state.page + getStep() + 1,
    ].filter((page) => page >= 1 && page <= state.totalPages);

    candidates.forEach((page) => {
      state.document.getPage(page).catch(() => {});
    });
  }
}

function showReaderError(flipbook, error) {
  const status = flipbook.querySelector("[data-flipbook-status]");
  const fallback = flipbook.querySelector("[data-flipbook-fallback]");

  if (status) {
    status.textContent = "The interactive reader is unavailable.";
  }

  if (fallback) {
    fallback.hidden = false;
  }

  console.error(error);
}
