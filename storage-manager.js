/**
 * Storage Manager: เก็บรูปภาพ, รายการที่ติ๊ก และข้อมูลเงิน/รายการต่างๆ
 */
const STORAGE_KEYS = {
  STATE: "app_state_v1",
  IMAGES: "app_images_v1",
  DB_NAME: "app_media_db_v1",
  DB_STORE: "images",
};

const defaultState = {
  checked: {},     // { itemId: true/false }
  counts: {},      // { itemId: number }
  money: {
    cash: 0,       // เงินสด / เงินที่บ้าน
    dirty: 0,      // เงินสกปรก
    expense: 0,    // รายจ่าย / ต้นทุน
    income: 0,     // รายรับ / กำไร
  },
  notes: "",
};

let appState = loadState();
let imageMap = loadImagesFromLocal();
let dbInstance = null;

// --- 1. โหลดและบันทึกข้อมูลที่ติ๊ก + เงิน ---
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STATE);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      ...defaultState,
      ...parsed,
      checked: { ...defaultState.checked, ...(parsed.checked || {}) },
      counts: { ...defaultState.counts, ...(parsed.counts || {}) },
      money: { ...defaultState.money, ...(parsed.money || {}) },
    };
  } catch (err) {
    console.error("โหลด state ไม่สำเร็จ:", err);
    return structuredClone(defaultState);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEYS.STATE, JSON.stringify(appState));
    renderMoneySummary();
  } catch (err) {
    console.error("บันทึก state ไม่สำเร็จ:", err);
  }
}

function setChecked(key, isChecked) {
  appState.checked[key] = Boolean(isChecked);
  saveState();
}

function setCount(key, value) {
  appState.counts[key] = Math.max(0, Number(value) || 0);
  saveState();
}

function setMoney(field, amount) {
  appState.money[field] = Number(amount) || 0;
  saveState();
}

function getNetMoney() {
  const { cash, dirty, income, expense } = appState.money;
  return {
    totalCash: cash + dirty,
    netProfit: income - expense,
    grandTotal: cash + dirty + income - expense,
  };
}

// --- 2. ย่อรูปก่อนเก็บด้วย Canvas ---
function resizeImageFile(file, maxSize = 400, quality = 0.85, mime = "image/webp") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL(mime, quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- 3. เก็บรูปใน IndexedDB (และสำรองใน localStorage) ---
function openImageDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return resolve(null);
    const req = indexedDB.open(STORAGE_KEYS.DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORAGE_KEYS.DB_STORE)) {
        db.createObjectStore(STORAGE_KEYS.DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function loadImagesFromLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.IMAGES) || "{}");
  } catch {
    return {};
  }
}

async function saveImage(slotKey, fileOrDataUrl, opts = {}) {
  const dataUrl =
    typeof fileOrDataUrl === "string"
      ? fileOrDataUrl
      : await resizeImageFile(
          fileOrDataUrl,
          opts.maxSize ?? 400,
          opts.quality ?? 0.85
        );

  imageMap[slotKey] = dataUrl;

  try {
    const db = dbInstance || (dbInstance = await openImageDB());
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_KEYS.DB_STORE, "readwrite");
        tx.objectStore(STORAGE_KEYS.DB_STORE).put(dataUrl, slotKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch (err) {
    console.warn("IndexedDB เก็บไม่ได้ ใช้ localStorage แทน:", err);
  }

  try {
    localStorage.setItem(STORAGE_KEYS.IMAGES, JSON.stringify(imageMap));
  } catch (err) {
    console.warn("localStorage เต็ม (แต่รูปอาจยังอยู่ใน IndexedDB):", err);
  }

  renderImageSlot(slotKey);
  return dataUrl;
}

async function getImage(slotKey) {
  if (imageMap[slotKey]) return imageMap[slotKey];
  try {
    const db = dbInstance || (dbInstance = await openImageDB());
    if (db) {
      const val = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_KEYS.DB_STORE, "readonly");
        const req = tx.objectStore(STORAGE_KEYS.DB_STORE).get(slotKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (val) {
        imageMap[slotKey] = val;
        return val;
      }
    }
  } catch (err) {
    console.error("อ่านรูปจาก IndexedDB ไม่สำเร็จ:", err);
  }
  return null;
}

async function removeImage(slotKey) {
  delete imageMap[slotKey];
  try {
    localStorage.setItem(STORAGE_KEYS.IMAGES, JSON.stringify(imageMap));
  } catch {}
  try {
    const db = dbInstance || (dbInstance = await openImageDB());
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_KEYS.DB_STORE, "readwrite");
        tx.objectStore(STORAGE_KEYS.DB_STORE).delete(slotKey);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch {}
  renderImageSlot(slotKey);
}

// --- 4. ผูกกับ DOM อัตโนมัติ ---
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "image/*";
fileInput.hidden = true;
document.body.appendChild(fileInput);

let activeUploadKey = "";
let activePasteKey = "";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file || !activeUploadKey) return;
  await saveImage(activeUploadKey, file);
  activeUploadKey = "";
});

// ติ๊ก checkbox (ใส่ data-check="ชื่อคีย์") และตัวเลขเงิน/จำนวน (ใส่ data-money="cash" หรือ data-count="ชื่อคีย์")
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches("[data-check]")) {
    setChecked(el.dataset.check, el.checked);
  } else if (el.matches("[data-count]")) {
    setCount(el.dataset.count, el.value);
  } else if (el.matches("[data-money]")) {
    setMoney(el.dataset.money, el.value);
  }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.matches("[data-money]")) {
    setMoney(el.dataset.money, el.value);
  } else if (el.matches("[data-count]")) {
    setCount(el.dataset.count, el.value);
  } else if (el.id === "notesInput") {
    appState.notes = el.value;
    saveState();
  }
});

// ปุ่มอัปโหลดรูป (data-upload="slot1"), ลบรูป (data-remove-img="slot1"), วางรูป (data-paste-img="slot1")
document.addEventListener("click", async (e) => {
  const up = e.target.closest("[data-upload]");
  if (up) {
    activeUploadKey = up.dataset.upload;
    fileInput.click();
    return;
  }

  const rm = e.target.closest("[data-remove-img]");
  if (rm) {
    await removeImage(rm.dataset.removeImg);
    return;
  }

  const pa = e.target.closest("[data-paste-img]");
  if (pa) {
    const key = pa.dataset.pasteImg;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          await saveImage(key, blob);
          return;
        }
      }
    } catch {}
    activePasteKey = key;
    alert("กด Ctrl+V (หรือ Cmd+V) เพื่อวางรูปลงช่อง " + key);
  }
});

// วางรูปด้วย Ctrl+V / Cmd+V
document.addEventListener("paste", async (e) => {
  if (!activePasteKey) return;
  const file = [...(e.clipboardData?.files || [])].find((f) =>
    f.type.startsWith("image/")
  );
  if (!file) return;
  e.preventDefault();
  const key = activePasteKey;
  activePasteKey = "";
  await saveImage(key, file);
});

// ลากไฟล์รูปมาวางบนปุ่ม/กรอบที่มี data-upload
document.addEventListener("dragover", (e) => {
  if (e.target.closest("[data-upload]")) e.preventDefault();
});

document.addEventListener("drop", async (e) => {
  const dropZone = e.target.closest("[data-upload]");
  if (!dropZone) return;
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) =>
    f.type.startsWith("image/")
  );
  if (file) await saveImage(dropZone.dataset.upload, file);
});

// --- 5. แสดงผลค่าที่บันทึกไว้ ---
async function renderImageSlot(slotKey) {
  const imgEl = document.querySelector(`[data-preview="${slotKey}"]`);
  if (!imgEl) return;
  const src = await getImage(slotKey);
  imgEl.src = src || "";
  imgEl.hidden = !src;
}

function renderMoneySummary() {
  const fmt = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const { totalCash, netProfit, grandTotal } = getNetMoney();
  const elCash = document.querySelector("#sumCash");
  const elProfit = document.querySelector("#sumProfit");
  const elGrand = document.querySelector("#sumGrand");
  if (elCash) elCash.textContent = fmt(totalCash);
  if (elProfit) elProfit.textContent = fmt(netProfit);
  if (elGrand) elGrand.textContent = fmt(grandTotal);
}

async function initStorageUI() {
  document.querySelectorAll("[data-check]").forEach((el) => {
    el.checked = Boolean(appState.checked[el.dataset.check]);
  });
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.value = appState.counts[el.dataset.count] ?? 0;
  });
  document.querySelectorAll("[data-money]").forEach((el) => {
    el.value = appState.money[el.dataset.money] ?? 0;
  });
  const notesEl = document.querySelector("#notesInput");
  if (notesEl) notesEl.value = appState.notes || "";

  const previewKeys = [
    ...document.querySelectorAll("[data-preview]"),
  ].map((el) => el.dataset.preview);
  await Promise.all(previewKeys.map(renderImageSlot));
  renderMoneySummary();
}

// --- 6. Export / Import ทั้งข้อมูลและรูป ---
async function exportAllData() {
  const allImgs = { ...imageMap };
  for (const k of Object.keys(allImgs)) {
    allImgs[k] = await getImage(k);
  }
  return JSON.stringify({ state: appState, images: allImgs });
}

async function importAllData(jsonText) {
  const data = JSON.parse(jsonText);
  if (data.state) {
    appState = { ...defaultState, ...data.state };
    saveState();
  }
  if (data.images && typeof data.images === "object") {
    for (const [k, v] of Object.entries(data.images)) {
      if (v) await saveImage(k, v, { maxSize: 1200 });
    }
  }
  await initStorageUI();
}

document.addEventListener("DOMContentLoaded", initStorageUI);
