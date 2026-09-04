export function initCommentSystem(config = {}) {
  const {
    googleScriptUrl,
    localStorageKey = "comment-pin-queue-v1",
    deleteQueueStorageKey = "comment-pin-delete-queue-v1",
    syncStatusBadgeId = "comment-sync-status-badge",
    pendingSyncRetryMs = 5000,
    dragThresholdPx = 8,
    commentBoxDefaultWidthPx = 200,
    popupAnchorOffsetPx = 16,
    statusOptions = ["Idea/Suggestion", "Copy/Content", "Question", "Bug"],
    anchorBinding = null,
    onDemo = null,
  } = config;

  if (!googleScriptUrl) {
    console.error("Comment system requires googleScriptUrl.");
    return;
  }

  if (typeof document !== "undefined" && document.body) {
    document.body.style.cursor = "crosshair";
  }

  let commentPinCounter = 0;
  let hasInitializedCommentPinCounter = false;
  let isFlushingPendingComments = false;
  let isFlushingPendingDeletes = false;
  let pendingSyncRetryTimer = null;
  let activePointerId = null;
  let pointerDownPosition = null;
  let pointerMovedBeyondThreshold = false;
  let suppressNextClick = false;
  let anchorSyncAnimationFrame = null;

  const hasDemoAction = typeof onDemo === "function";

  function ensureSyncActionBar() {
    let actionBar = document.getElementById(`${syncStatusBadgeId}-actions`);
    if (actionBar) {
      return actionBar;
    }

    actionBar = document.createElement("div");
    actionBar.id = `${syncStatusBadgeId}-actions`;
    actionBar.style.position = "fixed";
    actionBar.style.right = "16px";
    actionBar.style.bottom = "16px";
    actionBar.style.zIndex = "9999";
    actionBar.style.display = "flex";
    actionBar.style.alignItems = "center";
    actionBar.style.gap = "8px";
    actionBar.setAttribute("data-comment-suppressed", "true");
    document.body.appendChild(actionBar);
    return actionBar;
  }

  const hasAnchorBinding =
    Boolean(anchorBinding) &&
    typeof anchorBinding.resolveAnchor === "function" &&
    typeof anchorBinding.projectAnchor === "function";

  function calculatePointerTravelDistance(event) {
    if (!pointerDownPosition) {
      return 0;
    }

    const deltaX = event.pageX - pointerDownPosition.pageX;
    const deltaY = event.pageY - pointerDownPosition.pageY;
    return Math.hypot(deltaX, deltaY);
  }

  function handlePointerDown(event) {
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }

    activePointerId = event.pointerId;
    pointerDownPosition = {
      pageX: event.pageX,
      pageY: event.pageY,
    };
    pointerMovedBeyondThreshold = false;
    suppressNextClick = false;
  }

  function handlePointerMove(event) {
    if (event.pointerId !== activePointerId || !pointerDownPosition) {
      return;
    }

    if (pointerMovedBeyondThreshold) {
      return;
    }

    const travelDistance = calculatePointerTravelDistance(event);
    if (travelDistance > dragThresholdPx) {
      pointerMovedBeyondThreshold = true;
      suppressNextClick = true;
    }
  }

  function handlePointerEnd(event) {
    if (event.pointerId !== activePointerId) {
      return;
    }

    activePointerId = null;
    pointerDownPosition = null;
    pointerMovedBeyondThreshold = false;
  }

  function isCommentSuppressedTarget(targetElement) {
    return Boolean(
      targetElement.closest(
        "[data-reset-view], .viewer-panel__reset, [data-ui-toggle], [data-ui-toggle-button], [data-ui-floating-toggle], [data-demo-button], [data-comment-suppressed]",
      ),
    );
  }

  function readLocalCommentQueue() {
    try {
      const rawQueue = localStorage.getItem(localStorageKey);
      return rawQueue ? JSON.parse(rawQueue) : [];
    } catch (error) {
      console.error("Unable to read local comment queue:", error);
      return [];
    }
  }

  function writeLocalCommentQueue(queueItems, options = {}) {
    const { allowPrune = false } = options;

    if (allowPrune) {
      localStorage.setItem(localStorageKey, JSON.stringify(queueItems));
      return;
    }

    // Hard rule: never prune local history. If a write omits an existing item,
    // merge it back so localStorage keeps all records forever.
    const existingItems = readLocalCommentQueue();
    const mergedItemsByPinId = new Map();

    for (const item of existingItems) {
      if (item?.pinId != null) {
        mergedItemsByPinId.set(item.pinId, item);
      }
    }

    for (const item of queueItems) {
      if (item?.pinId != null) {
        mergedItemsByPinId.set(item.pinId, item);
      }
    }

    const mergedItems = Array.from(mergedItemsByPinId.values());
    localStorage.setItem(localStorageKey, JSON.stringify(mergedItems));
  }

  function readLocalDeleteQueue() {
    try {
      const rawQueue = localStorage.getItem(deleteQueueStorageKey);
      return rawQueue ? JSON.parse(rawQueue) : [];
    } catch (error) {
      console.error("Unable to read local delete queue:", error);
      return [];
    }
  }

  function writeLocalDeleteQueue(queueItems) {
    localStorage.setItem(deleteQueueStorageKey, JSON.stringify(queueItems));
  }

  function initializeCommentPinCounterFromLocalQueue() {
    if (hasInitializedCommentPinCounter) {
      return;
    }

    const queueItems = readLocalCommentQueue();
    let maxNumericPinId = -1;

    for (const item of queueItems) {
      const pinIdValue = item?.pinId;
      if (typeof pinIdValue !== "string") {
        continue;
      }

      if (!/^\d+$/.test(pinIdValue)) {
        continue;
      }

      const numericPinId = Number.parseInt(pinIdValue, 10);
      if (numericPinId > maxNumericPinId) {
        maxNumericPinId = numericPinId;
      }
    }

    commentPinCounter = maxNumericPinId + 1;
    hasInitializedCommentPinCounter = true;
  }

  function createCommentPinId() {
    initializeCommentPinCounterFromLocalQueue();
    const pinId = String(commentPinCounter).padStart(2, "0");
    commentPinCounter += 1;
    return pinId;
  }

  function createDeviceTimestamp() {
    return new Date().toISOString();
  }

  function setPinExpandedState(pinId, isExpanded) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (!pin) {
      return;
    }

    pin.classList.toggle("is-open", isExpanded);
    pin.setAttribute("aria-expanded", String(isExpanded));
  }

  function closeAllCommentPopups() {
    const popups = document.querySelectorAll(".comment-form-popup");
    popups.forEach((popup) => {
      const pinId = popup.getAttribute("data-pin-id");
      popup.style.display = "none";
      if (pinId) {
        setPinExpandedState(pinId, false);
      }
    });
  }

  function hideCommentPopupForPin(pinId) {
    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (!popup) {
      return;
    }

    popup.style.display = "none";
    setPinExpandedState(pinId, false);

    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (pin instanceof HTMLElement) {
      pin.blur();
    }
  }

  function showCommentPopupForPin(pinId) {
    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (!popup) {
      return;
    }

    closeAllCommentPopups();
    popup.style.display = "block";
    setPinExpandedState(pinId, true);

    const commentInput = popup.querySelector(".comment-input-field");
    if (commentInput instanceof HTMLTextAreaElement) {
      commentInput.focus();
    }
  }

  function toggleCommentPopupForPin(pinId) {
    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (!popup) {
      return;
    }

    if (popup.style.display === "none") {
      showCommentPopupForPin(pinId);
      return;
    }

    hideCommentPopupForPin(pinId);
  }

  function createPinAtCoordinates(x, y, pinId) {
    const existingPin = document.querySelector(
      `.comment-pin[data-pin-id="${pinId}"]`,
    );
    if (existingPin) {
      existingPin.style.left = `${x}px`;
      existingPin.style.top = `${y}px`;
      return;
    }

    const pin = document.createElement("div");
    pin.className = "comment-pin";
    pin.setAttribute("data-pin-id", pinId);
    pin.setAttribute("role", "button");
    pin.setAttribute("tabindex", "0");
    pin.setAttribute("aria-expanded", "false");
    pin.style.position = "absolute";
    pin.style.left = `${x}px`;
    pin.style.top = `${y}px`;
    pin.innerHTML = `
      <svg class="comment-pin__caret" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
        <path d="M4 2L8 6L4 10" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    document.body.appendChild(pin);
    setCommentAnchorVisualState(pinId, false);
  }

  function setCommentAnchorVisualState(pinId, isAnchored) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (pin instanceof HTMLElement) {
      pin.classList.toggle("comment-pin--anchored", isAnchored);
      pin.classList.toggle("comment-pin--free", !isAnchored);
      pin.setAttribute(
        "title",
        isAnchored ? "Anchored to 3D model" : "Free screen comment",
      );
      pin.setAttribute(
        "aria-label",
        isAnchored ? "Anchored comment pin" : "Free comment pin",
      );
    }

    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (popup instanceof HTMLElement) {
      popup.classList.toggle("comment-form-popup--anchored", isAnchored);
      popup.classList.toggle("comment-form-popup--free", !isAnchored);
    }
  }

  function setPinAnchorData(pinId, anchorData) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (!(pin instanceof HTMLElement) || !anchorData) {
      return;
    }

    pin.dataset.anchorData = JSON.stringify(anchorData);
    setCommentAnchorVisualState(pinId, true);
  }

  function getPinAnchorData(pinId) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (!(pin instanceof HTMLElement)) {
      return null;
    }

    const rawAnchorData = pin.dataset.anchorData;
    if (!rawAnchorData) {
      return null;
    }

    try {
      return JSON.parse(rawAnchorData);
    } catch (error) {
      return null;
    }
  }

  function getPinElement(pinId) {
    return document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
  }

  function getViewportMetrics() {
    return {
      viewportWidth:
        window.innerWidth || document.documentElement.clientWidth || 1,
      viewportHeight:
        window.innerHeight || document.documentElement.clientHeight || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  function setFreePinViewportRatio(pinId, xCoordinate, yCoordinate) {
    const pin = getPinElement(pinId);
    if (!(pin instanceof HTMLElement)) {
      return;
    }

    const { viewportWidth, viewportHeight, scrollX, scrollY } =
      getViewportMetrics();
    const ratioX = clampValue((xCoordinate - scrollX) / viewportWidth, 0, 1);
    const ratioY = clampValue((yCoordinate - scrollY) / viewportHeight, 0, 1);

    pin.dataset.freeRatioX = String(ratioX);
    pin.dataset.freeRatioY = String(ratioY);
  }

  function getFreePinViewportRatio(pinId) {
    const pin = getPinElement(pinId);
    if (!(pin instanceof HTMLElement)) {
      return null;
    }

    const ratioX = Number.parseFloat(pin.dataset.freeRatioX ?? "");
    const ratioY = Number.parseFloat(pin.dataset.freeRatioY ?? "");

    if (Number.isFinite(ratioX) && Number.isFinite(ratioY)) {
      return {
        ratioX: clampValue(ratioX, 0, 1),
        ratioY: clampValue(ratioY, 0, 1),
      };
    }

    const xCoordinate = Number.parseFloat(pin.style.left);
    const yCoordinate = Number.parseFloat(pin.style.top);
    if (!Number.isFinite(xCoordinate) || !Number.isFinite(yCoordinate)) {
      return null;
    }

    setFreePinViewportRatio(pinId, xCoordinate, yCoordinate);

    return {
      ratioX: Number.parseFloat(pin.dataset.freeRatioX ?? "0"),
      ratioY: Number.parseFloat(pin.dataset.freeRatioY ?? "0"),
    };
  }

  function updateFreePinQueuePosition(pinId, xCoordinate, yCoordinate, ratios) {
    const queueItems = readLocalCommentQueue();
    const queueItemIndex = queueItems.findIndex((item) => item.pinId === pinId);
    if (queueItemIndex === -1) {
      return;
    }

    const queueItem = queueItems[queueItemIndex];
    if (queueItem?.anchorData) {
      return;
    }

    queueItems[queueItemIndex] = {
      ...queueItem,
      xCoordinate,
      yCoordinate,
      freeRatioX: ratios.ratioX,
      freeRatioY: ratios.ratioY,
      updatedAt: Date.now(),
    };

    writeLocalCommentQueue(queueItems);
  }

  function setCommentVisibility(pinId, isVisible) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (pin instanceof HTMLElement) {
      pin.style.visibility = isVisible ? "visible" : "hidden";
    }

    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (popup instanceof HTMLElement) {
      popup.style.visibility = isVisible ? "visible" : "hidden";
    }
  }

  function updateCommentPosition(pinId, xCoordinate, yCoordinate) {
    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (pin instanceof HTMLElement) {
      pin.style.left = `${xCoordinate}px`;
      pin.style.top = `${yCoordinate}px`;
    }

    if (!getPinAnchorData(pinId)) {
      setFreePinViewportRatio(pinId, xCoordinate, yCoordinate);
    }

    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (!(popup instanceof HTMLElement)) {
      return;
    }

    const popupWidth = resolveCommentBoxWidth(popup);
    const popupPosition = getPopupViewportSafePosition(
      xCoordinate,
      yCoordinate,
      popupWidth,
    );

    popup.style.left = `${popupPosition.x}px`;
    popup.style.top = `${popupPosition.y}px`;

    const formElement = popup.querySelector(".comment-form");
    if (formElement instanceof HTMLElement) {
      formElement.style.left = `${popupPosition.x}px`;
      formElement.style.top = `${popupPosition.y}px`;
    }
  }

  function syncFreeCommentPositionsToViewport() {
    const freePins = document.querySelectorAll(".comment-pin[data-pin-id]");
    if (freePins.length === 0) {
      return;
    }

    const { viewportWidth, viewportHeight, scrollX, scrollY } =
      getViewportMetrics();

    for (const pin of freePins) {
      if (!(pin instanceof HTMLElement)) {
        continue;
      }

      const pinId = pin.getAttribute("data-pin-id");
      if (!pinId || getPinAnchorData(pinId)) {
        continue;
      }

      const ratios = getFreePinViewportRatio(pinId);
      if (!ratios) {
        continue;
      }

      const xCoordinate = scrollX + ratios.ratioX * viewportWidth;
      const yCoordinate = scrollY + ratios.ratioY * viewportHeight;

      updateCommentPosition(pinId, xCoordinate, yCoordinate);
      updateFreePinQueuePosition(pinId, xCoordinate, yCoordinate, ratios);
      setCommentVisibility(pinId, true);
    }
  }

  function resolveAnchorPlacement(event) {
    const pointerEventSupported =
      typeof PointerEvent !== "undefined" && event instanceof PointerEvent;
    const mouseEventSupported =
      typeof MouseEvent !== "undefined" && event instanceof MouseEvent;

    if (!hasAnchorBinding || !(pointerEventSupported || mouseEventSupported)) {
      return null;
    }

    try {
      const anchorPlacement = anchorBinding.resolveAnchor(event);
      if (!anchorPlacement || !anchorPlacement.anchorData) {
        return null;
      }

      if (
        typeof anchorPlacement.xCoordinate !== "number" ||
        typeof anchorPlacement.yCoordinate !== "number"
      ) {
        return null;
      }

      return anchorPlacement;
    } catch (error) {
      console.error("Failed to resolve Three.js anchor:", error);
      return null;
    }
  }

  function syncAnchoredCommentPositions() {
    if (!hasAnchorBinding) {
      return;
    }

    const queueItems = readLocalCommentQueue();

    for (const item of queueItems) {
      const pinId = item?.pinId;
      if (typeof pinId !== "string" || pinId.length === 0) {
        continue;
      }

      const anchorData = item?.anchorData ?? getPinAnchorData(pinId);
      if (!anchorData) {
        continue;
      }

      try {
        const projectedAnchor = anchorBinding.projectAnchor(anchorData);
        if (
          !projectedAnchor ||
          typeof projectedAnchor.xCoordinate !== "number" ||
          typeof projectedAnchor.yCoordinate !== "number"
        ) {
          // Keep anchored pins visible at their last known position when
          // projection is temporarily unavailable (e.g. during responsive swaps).
          setCommentVisibility(pinId, true);
          continue;
        }

        const clampedPoint = clampPointToViewport(
          projectedAnchor.xCoordinate,
          projectedAnchor.yCoordinate,
        );

        updateCommentPosition(
          pinId,
          clampedPoint.xCoordinate,
          clampedPoint.yCoordinate,
        );
        setCommentVisibility(pinId, true);
      } catch (error) {
        console.error("Failed to project Three.js anchor:", error);
      }
    }

    anchorSyncAnimationFrame = window.requestAnimationFrame(
      syncAnchoredCommentPositions,
    );
  }

  function refreshAnchoredCommentPositionsSoon() {
    if (!hasAnchorBinding) {
      return;
    }

    if (anchorSyncAnimationFrame !== null) {
      window.cancelAnimationFrame(anchorSyncAnimationFrame);
      anchorSyncAnimationFrame = null;
    }

    anchorSyncAnimationFrame = window.requestAnimationFrame(
      syncAnchoredCommentPositions,
    );
  }

  function refreshAllCommentPositionsSoon() {
    syncFreeCommentPositionsToViewport();
    refreshAnchoredCommentPositionsSoon();
  }

  function createStatusOptionsMarkup() {
    const options = [
      '<option value="" disabled selected>Comment type...</option>',
      ...statusOptions.map(
        (option) => `<option value="${option}">${option}</option>`,
      ),
    ];

    return options.join("\n");
  }

  function clampValue(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampPointToViewport(xCoordinate, yCoordinate) {
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth || 1;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 1;
    const minX = window.scrollX;
    const minY = window.scrollY;
    const maxX = window.scrollX + viewportWidth - 1;
    const maxY = window.scrollY + viewportHeight - 1;

    return {
      xCoordinate: clampValue(xCoordinate, minX, maxX),
      yCoordinate: clampValue(yCoordinate, minY, maxY),
    };
  }

  function resolveCommentBoxWidth(popupElement) {
    if (popupElement instanceof HTMLElement) {
      const measuredWidth = popupElement.getBoundingClientRect().width;
      if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
        return measuredWidth;
      }

      const cssWidth = Number.parseFloat(getComputedStyle(popupElement).width);
      if (Number.isFinite(cssWidth) && cssWidth > 0) {
        return cssWidth;
      }
    }

    return commentBoxDefaultWidthPx;
  }

  function getPopupViewportSafePosition(x, y, commentBoxWidth) {
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;

    let popupX = x + popupAnchorOffsetPx;
    let popupY = y + popupAnchorOffsetPx;

    // Use the comment box width as the edge threshold.
    if (x > viewportWidth - commentBoxWidth) {
      popupX = x - commentBoxWidth - popupAnchorOffsetPx;
    }

    if (y > viewportHeight - commentBoxWidth) {
      popupY = y - commentBoxWidth - popupAnchorOffsetPx;
    }

    const maxX = Math.max(0, viewportWidth - commentBoxWidth);
    const maxY = Math.max(0, viewportHeight - commentBoxWidth);

    return {
      x: clampValue(popupX, 0, maxX),
      y: clampValue(popupY, 0, maxY),
    };
  }

  function createPinFormPopup(x, y, pinId, initialValues = {}, options = {}) {
    const { collapsed = false } = options;
    const existingPopup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (existingPopup) {
      const existingPopupWidth = resolveCommentBoxWidth(existingPopup);
      const existingPopupPosition = getPopupViewportSafePosition(
        x,
        y,
        existingPopupWidth,
      );

      existingPopup.style.left = `${existingPopupPosition.x}px`;
      existingPopup.style.top = `${existingPopupPosition.y}px`;
      existingPopup.style.display = collapsed ? "none" : "block";
      setPinExpandedState(pinId, !collapsed);

      const existingForm = existingPopup.querySelector(".comment-form");
      if (existingForm) {
        existingForm.style.left = `${existingPopupPosition.x}px`;
        existingForm.style.top = `${existingPopupPosition.y}px`;

        const existingCommentInput = existingForm.querySelector(
          ".comment-input-field",
        );
        const existingTypeSelect =
          existingForm.querySelector(".comment-form-type");
        if (
          existingCommentInput &&
          typeof initialValues.commentText === "string"
        ) {
          existingCommentInput.value = initialValues.commentText;
        }
        if (existingTypeSelect && typeof initialValues.status === "string") {
          existingTypeSelect.value = initialValues.status;
        }

        const existingTimestampInput =
          existingForm.querySelector(".comment-timestamp");
        if (
          existingTimestampInput instanceof HTMLInputElement &&
          typeof initialValues.timestamp === "string"
        ) {
          existingTimestampInput.value = initialValues.timestamp;
        }
      }

      return;
    }

    const popup = document.createElement("div");
    popup.className = "comment-form-popup";
    popup.setAttribute("data-pin-id", pinId);
    popup.style.position = "absolute";
    const popupWidth = resolveCommentBoxWidth(popup);
    const popupPosition = getPopupViewportSafePosition(x, y, popupWidth);

    popup.style.left = `${popupPosition.x}px`;
    popup.style.top = `${popupPosition.y}px`;
    popup.style.display = collapsed ? "none" : "block";
    setPinExpandedState(pinId, !collapsed);
    popup.innerHTML = `
      <form class="comment-form">
        <input class="comment-timestamp" type="hidden" />
        <select class="comment-form-type">
          ${createStatusOptionsMarkup()}
        </select>
        <textarea class="comment-form-textarea comment-input-field" placeholder="Enter your comment" rows="4"></textarea>
        <button class="update-btn" type="submit">Comment</button><button class="delete-btn" type="button">Delete</button>
      </form>
    `;

    const formEl = popup.querySelector(".comment-form");
    formEl.setAttribute("data-pin-id", pinId);
    formEl.style.left = `${popupPosition.x}px`;
    formEl.style.top = `${popupPosition.y}px`;

    const commentInput = formEl.querySelector(".comment-input-field");
    if (commentInput && typeof initialValues.commentText === "string") {
      commentInput.value = initialValues.commentText;
    }

    const typeSelect = formEl.querySelector(".comment-form-type");
    if (typeSelect && typeof initialValues.status === "string") {
      typeSelect.value = initialValues.status;
    }

    const timestampInput = formEl.querySelector(".comment-timestamp");
    if (
      timestampInput instanceof HTMLInputElement &&
      typeof initialValues.timestamp === "string"
    ) {
      timestampInput.value = initialValues.timestamp;
    }

    formEl.addEventListener("submit", (event) => {
      event.preventDefault();
      handleCommentUpdate(formEl);
    });

    const deleteBtn = formEl.querySelector(".delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        if (
          confirm(
            "Delete Comment: This action cannot be undone. Are you sure you want to proceed?",
          )
        ) {
          // User clicked 'OK'
          console.log("Confirmed!");
          void removeCommentByPinId(pinId, deleteBtn);
        } else {
          // User clicked 'Cancel'
          console.log("Action cancelled.");
        }
      });
    }

    document.body.appendChild(popup);
  }

  function ensureSyncStatusBadge() {
    let badge = document.getElementById(syncStatusBadgeId);
    if (badge) {
      return badge;
    }

    const actionBar = ensureSyncActionBar();
    badge = document.createElement("div");
    badge.id = syncStatusBadgeId;
    badge.style.padding = "8px 10px";
    badge.style.borderRadius = "8px";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    badge.style.color = "#ffffff";
    badge.style.background = "rgba(27, 31, 35, 0.85)";
    badge.style.border = "1px solid rgba(255, 255, 255, 0.2)";
    badge.style.pointerEvents = "none";
    actionBar.appendChild(badge);
    return badge;
  }

  function ensureDemoButton() {
    if (!hasDemoAction) {
      return null;
    }

    let button = document.getElementById(`${syncStatusBadgeId}-demo`);
    if (button) {
      return button;
    }

    const actionBar = ensureSyncActionBar();
    button = document.createElement("button");
    button.id = `${syncStatusBadgeId}-demo`;
    button.type = "button";
    button.textContent = "Demo";
    button.setAttribute("data-demo-button", "true");
    button.setAttribute("aria-label", "Run driving demo");
    button.style.padding = "8px 12px";
    button.style.borderRadius = "8px";
    button.style.fontSize = "12px";
    button.style.fontWeight = "600";
    button.style.color = "#ffffff";
    button.style.background = "rgba(25, 108, 214, 1)";
    button.style.border = "1px solid rgba(255, 255, 255, 0.22)";
    button.style.cursor = "pointer";
    button.style.pointerEvents = "auto";
    button.style.boxShadow = "0 8px 24px rgba(8, 26, 56, 0.28)";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onDemo();
    });
    actionBar.appendChild(button);
    return button;
  }

  function getPendingCommentQueueItems() {
    return readLocalCommentQueue().filter((item) => !item.synced);
  }

  function getPendingDeleteQueueItems() {
    return readLocalDeleteQueue();
  }

  function updateSyncStatusBadge() {
    if (typeof document === "undefined") {
      return;
    }

    const badge = ensureSyncStatusBadge();
    ensureDemoButton();
    const pendingCommentCount = getPendingCommentQueueItems().length;
    const pendingDeleteCount = getPendingDeleteQueueItems().length;
    const pendingCount = pendingCommentCount + pendingDeleteCount;
    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;

    const pendingDetails = [];
    if (pendingCommentCount > 0) {
      pendingDetails.push(`Comments: ${pendingCommentCount}`);
    }
    if (pendingDeleteCount > 0) {
      pendingDetails.push(`Deletes: ${pendingDeleteCount}`);
    }
    const pendingSuffix = pendingDetails.length
      ? ` (${pendingDetails.join(" | ")})`
      : "";

    if (pendingCount > 0) {
      if (isOffline) {
        badge.textContent = `Offline • Pending: ${pendingCount}${pendingSuffix}`;
        badge.style.background = "rgba(133, 77, 14, 0.9)";
        return;
      }

      badge.textContent = `Syncing • Pending: ${pendingCount}${pendingSuffix}`;
      badge.style.background = "rgba(4, 88, 157, 0.9)";
      return;
    }

    if (isOffline) {
      badge.textContent = "Offline • All saved locally";
      badge.style.background = "rgba(86, 68, 24, 0.9)";
      return;
    }

    badge.textContent = "Synced";
    badge.style.background = "rgba(19, 104, 48, 0.9)";
  }

  function upsertCommentQueueItem(payload, overrides = {}) {
    const queueItems = readLocalCommentQueue();
    const itemIndex = queueItems.findIndex(
      (item) => item.pinId === payload.pinId,
    );
    const now = Date.now();

    if (itemIndex >= 0) {
      queueItems[itemIndex] = {
        ...queueItems[itemIndex],
        ...payload,
        ...overrides,
        updatedAt: now,
      };
    } else {
      queueItems.push({
        ...payload,
        synced: false,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      });
    }

    writeLocalCommentQueue(queueItems);
    updateSyncStatusBadge();
  }

  function markCommentQueueItemSynced(pinId) {
    const queueItems = readLocalCommentQueue();
    const itemIndex = queueItems.findIndex((item) => item.pinId === pinId);

    if (itemIndex === -1) {
      return;
    }

    queueItems[itemIndex] = {
      ...queueItems[itemIndex],
      synced: true,
      updatedAt: Date.now(),
      lastError: "",
    };
    writeLocalCommentQueue(queueItems);
    updateSyncStatusBadge();
  }

  function markCommentQueueItemPending(pinId, errorMessage) {
    const queueItems = readLocalCommentQueue();
    const itemIndex = queueItems.findIndex((item) => item.pinId === pinId);

    if (itemIndex === -1) {
      return;
    }

    queueItems[itemIndex] = {
      ...queueItems[itemIndex],
      synced: false,
      updatedAt: Date.now(),
      lastError: errorMessage || "Network unavailable",
    };
    writeLocalCommentQueue(queueItems);
    updateSyncStatusBadge();
  }

  function removeCommentQueueItem(pinId) {
    const queueItems = readLocalCommentQueue();
    const nextQueueItems = queueItems.filter((item) => item.pinId !== pinId);
    writeLocalCommentQueue(nextQueueItems, { allowPrune: true });
    updateSyncStatusBadge();
  }

  function upsertDeleteQueueItem(pinId) {
    const queueItems = readLocalDeleteQueue();
    const itemIndex = queueItems.findIndex((item) => item.pinId === pinId);
    const payload = {
      pinId,
      action: "delete",
      deletedAt: Date.now(),
    };

    if (itemIndex >= 0) {
      queueItems[itemIndex] = payload;
    } else {
      queueItems.push(payload);
    }

    writeLocalDeleteQueue(queueItems);
    updateSyncStatusBadge();
  }

  function removeDeleteQueueItem(pinId) {
    const queueItems = readLocalDeleteQueue();
    const nextQueueItems = queueItems.filter((item) => item.pinId !== pinId);
    writeLocalDeleteQueue(nextQueueItems);
    updateSyncStatusBadge();
  }

  function removeCommentFromUi(pinId) {
    const popup = document.querySelector(
      `.comment-form-popup[data-pin-id="${pinId}"]`,
    );
    if (popup) {
      popup.remove();
    }

    const pin = document.querySelector(`.comment-pin[data-pin-id="${pinId}"]`);
    if (pin) {
      pin.remove();
    }
  }

  async function removeCommentByPinId(pinId, deleteBtn) {
    const originalDeleteButtonText =
      deleteBtn instanceof HTMLButtonElement ? deleteBtn.innerText : "Delete";

    if (deleteBtn instanceof HTMLButtonElement) {
      deleteBtn.disabled = true;
      deleteBtn.innerText = "Deleting...";
    }

    const deletePayload = {
      pinId,
      action: "delete",
      deletedAt: Date.now(),
    };

    upsertDeleteQueueItem(pinId);

    const finalizeLocalDelete = () => {
      removeCommentFromUi(pinId);
      removeCommentQueueItem(pinId);
    };

    const queueDeleteForLaterSync = () => {
      upsertDeleteQueueItem(pinId);
      schedulePendingCommentSyncRetry();
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      finalizeLocalDelete();
      queueDeleteForLaterSync();
      return;
    }

    try {
      await sendDeleteToGoogle(deletePayload);
      removeDeleteQueueItem(pinId);
      finalizeLocalDelete();
    } catch (error) {
      finalizeLocalDelete();
      queueDeleteForLaterSync();

      if (deleteBtn instanceof HTMLButtonElement) {
        deleteBtn.disabled = false;
        deleteBtn.innerText = originalDeleteButtonText;
      }
    }
  }

  function restoreCommentPinsFromLocalQueue() {
    const queueItems = readLocalCommentQueue();
    const { viewportWidth, viewportHeight, scrollX, scrollY } =
      getViewportMetrics();

    for (const item of queueItems) {
      const pinId = item?.pinId;
      if (typeof pinId !== "string" || pinId.length === 0) {
        continue;
      }

      const xCoordinate = Number.parseFloat(String(item.xCoordinate));
      const yCoordinate = Number.parseFloat(String(item.yCoordinate));
      if (!Number.isFinite(xCoordinate) || !Number.isFinite(yCoordinate)) {
        continue;
      }

      const hasStoredFreeRatio =
        Number.isFinite(Number.parseFloat(String(item.freeRatioX))) &&
        Number.isFinite(Number.parseFloat(String(item.freeRatioY)));

      const restoredXCoordinate =
        !item.anchorData && hasStoredFreeRatio
          ? scrollX +
            clampValue(Number.parseFloat(String(item.freeRatioX)), 0, 1) *
              viewportWidth
          : xCoordinate;
      const restoredYCoordinate =
        !item.anchorData && hasStoredFreeRatio
          ? scrollY +
            clampValue(Number.parseFloat(String(item.freeRatioY)), 0, 1) *
              viewportHeight
          : yCoordinate;

      createPinAtCoordinates(restoredXCoordinate, restoredYCoordinate, pinId);
      if (item.anchorData) {
        setPinAnchorData(pinId, item.anchorData);
      } else {
        setCommentAnchorVisualState(pinId, false);
        setFreePinViewportRatio(
          pinId,
          restoredXCoordinate,
          restoredYCoordinate,
        );
      }
      createPinFormPopup(
        restoredXCoordinate,
        restoredYCoordinate,
        pinId,
        {
          commentText: item.commentText,
          status: item.status,
          timestamp: item.timestamp,
        },
        { collapsed: true },
      );

      if (item.anchorData && hasAnchorBinding) {
        try {
          const projectedAnchor = anchorBinding.projectAnchor(item.anchorData);
          if (
            projectedAnchor &&
            typeof projectedAnchor.xCoordinate === "number" &&
            typeof projectedAnchor.yCoordinate === "number"
          ) {
            updateCommentPosition(
              pinId,
              projectedAnchor.xCoordinate,
              projectedAnchor.yCoordinate,
            );

            if (typeof projectedAnchor.visible === "boolean") {
              setCommentVisibility(pinId, projectedAnchor.visible);
            }
          }
        } catch (error) {
          console.error("Failed to restore Three.js anchor position:", error);
        }
      }
    }
  }

  function schedulePendingCommentSyncRetry() {
    if (pendingSyncRetryTimer !== null) {
      return;
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return;
    }

    pendingSyncRetryTimer = window.setTimeout(() => {
      pendingSyncRetryTimer = null;
      flushPendingCommentQueue();
      flushPendingDeleteQueue();
    }, pendingSyncRetryMs);
  }

  function sendCommentToGoogle(payload) {
    return fetch(googleScriptUrl, {
      method: "POST",
      mode: "no-cors", // Apps Script requires no-cors redirect handling
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  function sendDeleteToGoogle(deleteItem) {
    return sendCommentToGoogle({
      pinId: deleteItem.pinId,
      action: "delete",
      deletedAt: deleteItem.deletedAt,
    });
  }

  function buildCommentPayload(source) {
    return {
      pinId: source.pinId,
      timestamp: source.timestamp,
      date: source.timestamp,
      xCoordinate: source.xCoordinate,
      yCoordinate: source.yCoordinate,
      commentText: source.commentText,
      status: source.status,
    };
  }

  async function flushPendingCommentQueue() {
    if (isFlushingPendingComments) {
      return;
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      updateSyncStatusBadge();
      return;
    }

    const pendingItems = getPendingCommentQueueItems();
    if (pendingItems.length === 0) {
      return;
    }

    isFlushingPendingComments = true;

    try {
      for (const item of pendingItems) {
        const payload = buildCommentPayload(item);

        try {
          await sendCommentToGoogle(payload);
          markCommentQueueItemSynced(item.pinId);
        } catch (error) {
          markCommentQueueItemPending(item.pinId, error?.message);
          schedulePendingCommentSyncRetry();
        }
      }
    } finally {
      isFlushingPendingComments = false;
      updateSyncStatusBadge();
    }
  }

  async function flushPendingDeleteQueue() {
    if (isFlushingPendingDeletes) {
      return;
    }

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      updateSyncStatusBadge();
      return;
    }

    const pendingDeleteItems = getPendingDeleteQueueItems();
    if (pendingDeleteItems.length === 0) {
      return;
    }

    isFlushingPendingDeletes = true;

    try {
      for (const deleteItem of pendingDeleteItems) {
        try {
          await sendDeleteToGoogle(deleteItem);
          removeDeleteQueueItem(deleteItem.pinId);
        } catch (error) {
          schedulePendingCommentSyncRetry();
          break;
        }
      }
    } finally {
      isFlushingPendingDeletes = false;
      updateSyncStatusBadge();
    }
  }

  async function handleCommentUpdate(formElement) {
    const pinId = formElement.getAttribute("data-pin-id");
    const commentInput = formElement.querySelector(".comment-input-field");
    const typeSelect = formElement.querySelector(".comment-form-type");
    const timestampInput = formElement.querySelector(".comment-timestamp");
    const timestamp = createDeviceTimestamp();
    const anchorData = getPinAnchorData(pinId);
    const freeRatios = !anchorData ? getFreePinViewportRatio(pinId) : null;

    if (timestampInput instanceof HTMLInputElement) {
      timestampInput.value = timestamp;
    }

    const payload = buildCommentPayload({
      pinId,
      timestamp,
      xCoordinate: formElement.style.left,
      yCoordinate: formElement.style.top,
      commentText: commentInput.value,
      status: typeSelect ? typeSelect.value : "",
    });

    upsertCommentQueueItem(payload, {
      anchorData,
      freeRatioX: freeRatios?.ratioX,
      freeRatioY: freeRatios?.ratioY,
      synced: false,
      lastError: "",
    });

    const updateBtn = formElement.querySelector(".update-btn");
    const originalText = updateBtn.innerText;
    updateBtn.innerText = "Saving...";

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      updateBtn.innerText = "Saved Offline";
      updateSyncStatusBadge();
      return;
    }

    try {
      await sendCommentToGoogle(payload);
      markCommentQueueItemSynced(pinId);
      flushPendingCommentQueue();
      updateBtn.innerText = "Saved!";
      setTimeout(() => {
        updateBtn.innerText = originalText;
      }, 2000);
      console.log("Sheet successfully updated.");
    } catch (error) {
      markCommentQueueItemPending(pinId, error?.message);
      schedulePendingCommentSyncRetry();
      console.error("Error saving to Google Sheets:", error);
      updateBtn.innerText = "Saved Offline";
    }
  }

  document.addEventListener("pointerdown", handlePointerDown, {
    passive: true,
  });

  document.addEventListener("pointermove", handlePointerMove, {
    passive: true,
  });

  document.addEventListener("pointerup", handlePointerEnd, {
    passive: true,
  });

  document.addEventListener("pointercancel", handlePointerEnd, {
    passive: true,
  });

  document.addEventListener("click", (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (!(event.target instanceof Element)) {
      return;
    }

    if (isCommentSuppressedTarget(event.target)) {
      return;
    }

    if (event.target.closest(".comment-form-popup")) return;

    const clickedPin = event.target.closest(".comment-pin");
    if (clickedPin) {
      const pinId = clickedPin.getAttribute("data-pin-id");
      if (pinId) {
        toggleCommentPopupForPin(pinId);
      }
      return;
    }

    const xCoordinate = event.pageX;
    const yCoordinate = event.pageY;
    const pinId = createCommentPinId();
    const anchorPlacement = resolveAnchorPlacement(event);
    const pinXCoordinate = anchorPlacement?.xCoordinate ?? xCoordinate;
    const pinYCoordinate = anchorPlacement?.yCoordinate ?? yCoordinate;

    closeAllCommentPopups();
    createPinAtCoordinates(pinXCoordinate, pinYCoordinate, pinId);
    createPinFormPopup(pinXCoordinate, pinYCoordinate, pinId);
    setCommentAnchorVisualState(pinId, false);

    if (!anchorPlacement?.anchorData) {
      setFreePinViewportRatio(pinId, pinXCoordinate, pinYCoordinate);
    }

    if (anchorPlacement?.anchorData) {
      setPinAnchorData(pinId, anchorPlacement.anchorData);
      updateCommentPosition(pinId, pinXCoordinate, pinYCoordinate);
    }
  });

  window.addEventListener("online", () => {
    console.log("Connection restored. Syncing pending comments...");
    updateSyncStatusBadge();
    flushPendingCommentQueue();
    flushPendingDeleteQueue();
  });

  window.addEventListener("offline", () => {
    console.log("Offline mode. Comments will sync when connected.");
    updateSyncStatusBadge();
  });

  window.addEventListener("resize", refreshAllCommentPositionsSoon, {
    passive: true,
  });
  window.addEventListener("orientationchange", refreshAllCommentPositionsSoon, {
    passive: true,
  });

  initializeCommentPinCounterFromLocalQueue();
  restoreCommentPinsFromLocalQueue();

  if (hasAnchorBinding) {
    syncAnchoredCommentPositions();
  }

  syncFreeCommentPositionsToViewport();

  updateSyncStatusBadge();
  flushPendingCommentQueue();
  flushPendingDeleteQueue();
}
