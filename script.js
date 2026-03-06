// script.js — полная версия (Leaflet + Leaflet-Geoman)
// Поддерживает: рисование/редактирование полигонов, кисть (клик + drag-paint), autosave, импорт/экспорт, undo.

// ======================
// Конфигурация статусов
// ======================
const STATUS_CONFIG = {
    axis: { color: "#8B0000", label: "Под контролем Оси" },
    contested: { color: "#FFA500", label: "Спорный участок" },
    allies: { color: "#00008B", label: "Под контролом Союзников" } // note: label typo fixed in usage if needed
};

const STORAGE_KEY = "war_map_autosave_v1";

// ======================
// Состояние приложения
// ======================
let map;
let imageOverlay = null;

let sectors = {};         // { id: { id, layer, name, status, description } }
let deletedStack = [];    // для undo
let currentEditingLayerId = null;
let isViewerMode = false;

// Brush (кисть) state
let statusBrushActive = false;
let selectedBrushStatus = "axis";
let isPainting = false;   // при drag-покраске

// ======================
// Инициализация карты
// ======================
document.addEventListener("DOMContentLoaded", () => {
    // Защита: если нет контейнера, ничего не делаем
    if (!document.getElementById("map")) {
        console.error("Map container #map not found.");
        return;
    }

    map = L.map("map", {
        crs: L.CRS.Simple,
        minZoom: -5,
        maxZoom: 5,
        zoomControl: true,
        attributionControl: false
    });

    // Geoman
    if (map.pm) {
        map.pm.setLang("ru");
        map.pm.addControls({
            position: "topleft",
            drawMarker: false,
            drawCircleMarker: false,
            drawPolyline: false,
            drawRectangle: false,
            drawCircle: false,
            drawText: false,
            editMode: false,
            dragMode: false,
            cutPolygon: false,
            removalMode: false
        });
    }

    // Скрыть стандартный toolbar Geoman (если он есть)
    const toolbar = document.querySelector(".leaflet-pm-toolbar");
    if (toolbar) toolbar.style.display = "none";

    createLegend();
    initEventListeners();
    loadAutosave();
    loadMapFromURL();

    // События Geoman: создание полигона и редактирование глобально
    map.on("pm:create", onSectorCreate);
    map.on("pm:globaleditmodetoggled", autosave); // autosave при включении/выключении редактирования
    map.on("pm:edit", autosave);
    map.on("pm:dragstart", autosave);
});

// ======================
// Вспомогательные функции
// ======================

// Преобразует сложную структуру latlngs в массив колец [[ [x,y], ... ], ...]
function latlngsToRings(latlngs) {
    // Leaflet может вернуть [ [latlng,...] ] или [[[latlng,...]]] для MultiPolygon
    // Мы нормализуем до массива колец, где каждая вершина — [x, y] (x=lng, y=lat)
    const rings = [];

    function processRing(ring) {
        const points = ring.map(p => [p.lng, p.lat]);
        if (points.length >= 3) rings.push(points);
    }

    if (!Array.isArray(latlngs)) return rings;

    // if first element is array of LatLng (simple polygon)
    if (latlngs.length && latlngs[0] && !Array.isArray(latlngs[0][0])) {
        // latlngs is array of latlngs
        processRing(latlngs);
    } else {
        // nested arrays: could be [ [latlngs], [hole], ... ] or MultiPolygon [[[...]]]
        // Walk recursively until we reach arrays of points
        const stack = [latlngs];
        while (stack.length) {
            const cur = stack.pop();
            if (!cur) continue;
            // check if cur is ring (array of latlng objects)
            if (cur.length && cur[0] && typeof cur[0].lat === "number" && typeof cur[0].lng === "number") {
                processRing(cur);
            } else {
                // push children
                for (let i = 0; i < cur.length; i++) {
                    if (Array.isArray(cur[i])) stack.push(cur[i]);
                }
            }
        }
    }
    return rings;
}

// Точка в полигоне — классический ray-casting
function pointInRing(point, ring) {
    // point: [x, y], ring: [[x,y],...]
    let x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];

        const intersect = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Проверить, лежит ли точка внутри любого кольца полигона (учитываем возможные "дырки")
function pointInPolygon(point, rings) {
    if (!rings || rings.length === 0) return false;
    // По соглашению: первый ring — внешняя оболочка, остальные — вычитающие (дыры)
    if (!pointInRing(point, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
        if (pointInRing(point, rings[i])) {
            // точка внутри дыры -> не внутри полигона
            return false;
        }
    }
    return true;
}

// Найти сектор под координатами latlng. Возвращает id или null
function findSectorAtLatLng(latlng) {
    // Преобразуем в [x,y] = [lng, lat]
    const pt = [latlng.lng, latlng.lat];
    for (const id in sectors) {
        const s = sectors[id];
        try {
            const latlngs = s.layer.getLatLngs();
            const rings = latlngsToRings(latlngs);
            if (pointInPolygon(pt, rings)) {
                return id;
            }
        } catch (err) {
            // пропускаем слой, если что-то не так
            continue;
        }
    }
    return null;
}

// Установить стиль полигона по статусу
function setLayerStyleByStatus(layer, status) {
    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.contested;
    if (layer.setStyle) {
        layer.setStyle({
            color: cfg.color,
            fillColor: cfg.color,
            fillOpacity: 0.5,
            weight: 2
        });
    }
}

// Сохранение в localStorage
function autosave() {
    try {
        const data = Object.values(sectors).map(s => ({
            name: s.name,
            status: s.status,
            description: s.description,
            latlngs: s.layer.getLatLngs()
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        // console.log("Autosaved", data.length, "sectors");
    } catch (err) {
        console.warn("Autosave failed:", err);
    }
}

// Загрузка из localStorage
function loadAutosave() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const imported = JSON.parse(raw);
        imported.forEach(item => {
            try {
                const layer = L.polygon(item.latlngs).addTo(map);
                const id = L.stamp(layer);
                sectors[id] = {
                    id,
                    layer,
                    name: item.name,
                    status: item.status,
                    description: item.description
                };
                setupLayerEvents(layer, id);
                setLayerStyleByStatus(layer, item.status);
            } catch (e) {
                console.warn("Failed to restore sector:", e);
            }
        });
        updateSidebar();
    } catch (err) {
        console.warn("Load autosave failed:", err);
    }
}

// ======================
// События Geoman / Создание сектора
// ======================
function onSectorCreate(e) {
    const layer = e.layer;
    const id = L.stamp(layer);

    sectors[id] = {
        id,
        layer,
        name: `Сектор ${Object.keys(sectors).length + 1}`,
        status: "contested",
        description: ""
    };

    setupLayerEvents(layer, id);
    setLayerStyleByStatus(layer, "contested");
    updateSidebar();
    autosave();

    // открыть модалку сразу
    openModal(id);
}

// ======================
// События слоя (клик — либо кисть, либо модалка)
// ======================
function setupLayerEvents(layer, id) {
    // Убираем предыдущее, если есть
    layer.off && layer.off();

    layer.on("click", (ev) => {
        const sector = sectors[id];
        if (!sector) return;

        // Если кисть включена — просто перекрашиваем сектор
        if (statusBrushActive) {
            sector.status = selectedBrushStatus;
            setLayerStyleByStatus(sector.layer, sector.status);
            updateSidebar();
            autosave();
            return;
        }

        // Обычное поведение
        if (!isViewerMode) {
            openModal(id);
        } else {
            layer.bindPopup(`
                <b>${sector.name}</b><br>
                <i>${(STATUS_CONFIG[sector.status] || {}).label || sector.status}</i><br>
                <p>${sector.description || ""}</p>
            `).openPopup();
        }
    });

    // При редактировании полигона (drag vertices / edit) — обновляем autosave
    if (layer.on) {
        layer.on("pm:edit", () => {
            autosave();
            updateSidebar();
        });
        layer.on("pm:dragend", () => {
            autosave();
            updateSidebar();
        });
    }
}

// ======================
// UI: init listeners
// ======================
function initEventListeners() {
    // Безопасные ссылки на элементы (если отсутствуют — игнорируем)
    const btnDraw = document.getElementById("btn-draw");
    const btnExport = document.getElementById("btn-export");
    const mapUpload = document.getElementById("map-upload");
    const mapImport = document.getElementById("map-import");
    const viewToggle = document.getElementById("view-mode-toggle");
const btnShare = document.getElementById("btn-share");

if (btnShare) {
    btnShare.addEventListener("click", () => {

        const link = generateShareLink();

        navigator.clipboard.writeText(link);

        alert("Ссылка скопирована:\n" + link);

    });
}
    if (btnDraw && map.pm) {
        btnDraw.addEventListener("click", () => {
            map.pm.enableDraw("Polygon", { snappable: true, snapDistance: 20 });
        });
    }

    if (mapUpload) {
        mapUpload.addEventListener("change", handleMapUpload);
    }

    if (btnExport) {
        btnExport.addEventListener("click", exportMapData);
    }

    if (mapImport) {
        mapImport.addEventListener("change", importMapData);
    }

    if (viewToggle) {
        viewToggle.addEventListener("change", (e) => {
            isViewerMode = e.target.checked;
            const adminElements = document.querySelectorAll(".admin-only");
            adminElements.forEach(el => el.style.display = isViewerMode ? "none" : "block");
            map.pm && map.pm.disableDraw();
        });
    }

    // Edit button (если добавишь в HTML)
    const btnEdit = document.getElementById("btn-edit");
    if (btnEdit && map.pm) {
        btnEdit.addEventListener("click", () => {
            map.pm.toggleGlobalEditMode();
        });
    }

    // Undo delete
    const btnUndo = document.getElementById("btn-undo");
    if (btnUndo) {
        btnUndo.addEventListener("click", undoDelete);
    }

    // Modal actions
    const btnSaveSector = document.getElementById("btn-save-sector");
    const btnDeleteSector = document.getElementById("btn-delete-sector");
    const btnCloseModal = document.getElementById("btn-close-modal");
    if (btnSaveSector) btnSaveSector.addEventListener("click", saveSectorFromModal);
    if (btnDeleteSector) btnDeleteSector.addEventListener("click", deleteSectorFromModal);
    if (btnCloseModal) btnCloseModal.addEventListener("click", closeModal);

    // Brush controls: включение кисти
    const brushBtn = document.getElementById("btn-brush");
    if (brushBtn) {
        brushBtn.addEventListener("click", () => {
            statusBrushActive = !statusBrushActive;
            map.getContainer().style.cursor = statusBrushActive ? "crosshair" : "";
            brushBtn.textContent = statusBrushActive ? "Кисть: Вкл" : "Кисть: Выкл";
        });
    }

    // Кнопки выбора статуса кисти (которые ты добавил в HTML с классом .brush-status)
    document.querySelectorAll(".brush-status").forEach(btn => {
        btn.addEventListener("click", () => {
            const s = btn.dataset.status;
            if (!s) return;
            selectedBrushStatus = s;
            // визуальная подсветка
            document.querySelectorAll(".brush-status").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
        });
    });

    // Drag-paint (покраска при удержании кнопки и движении мыши)
    // Используем события карты для надёжности
    map.on("mousedown", (ev) => {
        // Левой кнопкой только
        if (statusBrushActive && ev.originalEvent && ev.originalEvent.button === 0) {
            isPainting = true;
            paintAtLatLng(ev.latlng);
        }
    });

    map.on("mousemove", (ev) => {
        if (statusBrushActive && isPainting && ev.latlng) {
            paintAtLatLng(ev.latlng);
        }
    });

    // Останавливаем покраску при отпускании кнопки или выходе мыши
    document.addEventListener("mouseup", () => {
        if (isPainting) {
            isPainting = false;
            autosave();
        }
    });

    // Такой же стоп если мышь покидает контейнер карты
    map.getContainer().addEventListener("mouseleave", () => {
        if (isPainting) {
            isPainting = false;
            autosave();
        }
    });
}

// ======================
// Paint helpers
// ======================
function paintAtLatLng(latlng) {
    const id = findSectorAtLatLng(latlng);
    if (!id) return;
    const s = sectors[id];
    if (!s) return;
    if (s.status === selectedBrushStatus) return; // уже такой статус
    s.status = selectedBrushStatus;
    setLayerStyleByStatus(s.layer, s.status);
    updateSidebar(); // обновить список
}

// ======================
// Sidebar (список секторов)
// ======================
function updateSidebar() {
    const list = document.getElementById("sector-list");
    if (!list) return;
    list.innerHTML = "";
    Object.values(sectors).forEach(s => {
        const li = document.createElement("li");
        li.textContent = s.name;
        const color = (STATUS_CONFIG[s.status] || {}).color || "gray";
        li.style.borderLeft = `5px solid ${color}`;
        li.addEventListener("click", () => {
            try {
                map.fitBounds(s.layer.getBounds());
            } catch (e) { /* ignore */ }
            if (!isViewerMode) openModal(s.id);
        });
        list.appendChild(li);
    });
}

// ======================
// Modal (редактирование сектора)
// ======================
function openModal(id) {
    currentEditingLayerId = id;
    const sector = sectors[id];
    if (!sector) return;
    const modal = document.getElementById("sector-modal");
    if (!modal) return;
    const nameEl = document.getElementById("sector-name");
    const statusEl = document.getElementById("sector-status");
    const descEl = document.getElementById("sector-desc");
    if (nameEl) nameEl.value = sector.name;
    if (statusEl) statusEl.value = sector.status;
    if (descEl) descEl.value = sector.description;
    // Показать кнопку удаления
    const btnDelete = document.getElementById("btn-delete-sector");
    if (btnDelete) btnDelete.classList.remove("hidden");
    modal.classList.remove("hidden");
}
function closeModal() {
    const modal = document.getElementById("sector-modal");
    if (modal) modal.classList.add("hidden");
    currentEditingLayerId = null;
}

function saveSectorFromModal() {
    if (!currentEditingLayerId) return;
    const sector = sectors[currentEditingLayerId];
    if (!sector) return;
    const nameEl = document.getElementById("sector-name");
    const statusEl = document.getElementById("sector-status");
    const descEl = document.getElementById("sector-desc");
    sector.name = (nameEl && nameEl.value) ? nameEl.value : sector.name;
    sector.status = (statusEl && statusEl.value) ? statusEl.value : sector.status;
    sector.description = (descEl && descEl.value) ? descEl.value : sector.description;
    setLayerStyleByStatus(sector.layer, sector.status);
    updateSidebar();
    autosave();
    closeModal();
}

function deleteSectorFromModal() {
    if (!currentEditingLayerId) return;
    const sector = sectors[currentEditingLayerId];
    if (!sector) return;
    // push to undo stack (копия объекта, layer остаётся тем же)
    deletedStack.push({
        id: sector.id,
        layer: sector.layer,
        name: sector.name,
        status: sector.status,
        description: sector.description
    });
    try { map.removeLayer(sector.layer); } catch (e) { /* ignore */ }
    delete sectors[currentEditingLayerId];
    updateSidebar();
    autosave();
    closeModal();
}

// Undo удаления
function undoDelete() {
    const item = deletedStack.pop();
    if (!item) return;
    try {
        item.layer.addTo(map);
        const id = L.stamp(item.layer);
        // Восстановим с новым id, если id изменился
        const restoredId = id || item.id;
        sectors[restoredId] = {
            id: restoredId,
            layer: item.layer,
            name: item.name,
            status: item.status,
            description: item.description
        };
        setupLayerEvents(item.layer, restoredId);
        setLayerStyleByStatus(item.layer, item.status);
        updateSidebar();
        autosave();
    } catch (e) {
        console.warn("Undo failed:", e);
    }
}

// ======================
// Импорт / Экспорт / Загрузка карты
// ======================
function exportMapData() {
    const exportData = Object.values(sectors).map(s => ({
        name: s.name,
        status: s.status,
        description: s.description,
        latlngs: s.layer.getLatLngs()
    }));
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData));
    const a = document.createElement("a");
    a.setAttribute("href", dataStr);
    a.setAttribute("download", "war_map_backup.json");
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function importMapData(e) {
    const file = (e && e.target && e.target.files && e.target.files[0]) ? e.target.files[0] : null;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
        try {
            const imported = JSON.parse(ev.target.result);
            // Очистим текущие сектора
            Object.values(sectors).forEach(s => {
                try { map.removeLayer(s.layer); } catch (e) {}
            });
            sectors = {};
            imported.forEach(item => {
                const layer = L.polygon(item.latlngs).addTo(map);
                const id = L.stamp(layer);
                sectors[id] = {
                    id,
                    layer,
                    name: item.name,
                    status: item.status,
                    description: item.description
                };
                setupLayerEvents(layer, id);
                setLayerStyleByStatus(layer, item.status);
            });
            updateSidebar();
            autosave();
            alert("Карта успешно загружена");
        } catch (err) {
            console.warn("Import failed:", err);
            alert("Ошибка чтения JSON-файла.");
        }
    };
    reader.readAsText(file);
    // сброс input, чтобы можно было загрузить тот же файл снова
    if (e && e.target) e.target.value = "";
}

// ======================
// Загрузка изображения карты (поддержка больших карт)
// ======================
function handleMapUpload(e) {
    const file = (e && e.target && e.target.files && e.target.files[0]) ? e.target.files[0] : null;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
        try {
            const img = new Image();
            img.onload = function () {
                const w = img.width;
                const h = img.height;
                const bounds = [[0, 0], [h, w]];
                if (imageOverlay) {
                    try { map.removeLayer(imageOverlay); } catch (err) {}
                }
                imageOverlay = L.imageOverlay(img.src, bounds).addTo(map);
                map.setMaxBounds(bounds);
                map.fitBounds(bounds);
            };
            img.src = ev.target.result;
        } catch (err) {
            console.warn("Map upload failed:", err);
            alert("Не удалось загрузить изображение карты.");
        }
    };
    reader.readAsDataURL(file);
}

// ======================
// Легенда статусов
// ======================
function createLegend() {
    try {
        const legend = L.control({ position: "bottomright" });
        legend.onAdd = function () {
            const div = L.DomUtil.create("div", "legend");
            div.style.background = "rgba(30,30,30,0.9)";
            div.style.padding = "8px";
            div.style.border = "1px solid rgba(255,255,255,0.05)";
            div.style.color = "#ddd";
            div.innerHTML = "<b>Статусы</b><br>";
            for (const key in STATUS_CONFIG) {
                const s = STATUS_CONFIG[key];
                div.innerHTML += `
                    <div style="display:flex;align-items:center;margin-top:6px">
                        <span style="display:inline-block;width:14px;height:14px;background:${s.color};margin-right:8px;border:1px solid rgba(0,0,0,0.2)"></span>
                        ${s.label}
                    </div>
                `;
            }
            return div;
        };
        legend.addTo(map);
    } catch (e) {
        console.warn("Legend creation failed:", e);
    }
}
async function loadMapFromURL() {

    const params = new URLSearchParams(window.location.search);
    const mapName = params.get("map");

    if (!mapName) return;
    const img = new Image();
    img.src = "maps/" + mapName + ".jpg";

    img.onload = () => {
        loadMapImage(img);
    };

    try {

        const response = await fetch("maps/" + mapName + ".json");

        if (!response.ok) {
            console.error("Файл карты не найден:", mapName);
            return;
        }

        const data = await response.json();

        data.forEach(item => {

            const layer = L.polygon(item.latlngs).addTo(map);

            const id = L.stamp(layer);

            sectors[id] = {
                id,
                layer,
                name: item.name,
                status: item.status,
                description: item.description
            };

            setupLayerEvents(layer, id);
            setLayerStyleByStatus(layer, item.status);

        });

        updateSidebar();

    } catch (err) {

        console.error("Ошибка загрузки карты:", err);

    }
}
function generateShareLink(){

    const params = new URLSearchParams(window.location.search);

    const mapName = params.get("map") || "sicily";

    return window.location.origin +
           window.location.pathname +
           "?map=" + mapName;


}
