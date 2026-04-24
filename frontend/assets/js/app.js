(() => {
  const API_BASE_URL = (window.DASHBOARD_API_BASE_URL || "http://127.0.0.1:3000/api").replace(/\/$/, "");

  if (!window.maplibregl || !window.AuditMap) {
    console.error("MapLibre GL or AuditMap failed to load.");
    return;
  }

  const state = {
    mapFilter: "kabkota",
    tab: "kabupaten",
    selectedAreaKey: null,
    selectedOwnerKey: null,
    search: "",
    sortBy: "waste",
    modalRequestId: 0,
    modal: {
      areaType: "region",
      areaKey: null,
      ownerName: "",
      page: 1,
      pageSize: 25,
      search: "",
      ownerType: "",
      severity: "",
      priorityOnly: false,
    },
  };

  const dom = {
    kpi: document.getElementById("kpi"),
    mapRoot: document.getElementById("map"),
    mapFilters: document.getElementById("mf"),
    tabs: document.getElementById("tabs"),
    legend: document.getElementById("legend"),
    sidebarContent: document.getElementById("sbc"),
    modal: document.getElementById("rupModal"),
    modalTop: document.getElementById("modalTop"),
    modalBody: document.getElementById("modalBody"),
  };

  if (Object.values(dom).some((element) => !element)) {
    console.error("Dashboard shell is incomplete.");
    return;
  }

  const FILTERS = [
    { key: "central", label: "Kementerian/Lembaga" },
    { key: "provinsi", label: "Pemprov" },
    { key: "kabkota", label: "Pemkot" },
    { key: "other", label: "Others" },
  ];

  const TABS = [
    { key: "all", label: "Semua" },
    { key: "kabupaten", label: "Kabupaten" },
    { key: "kota", label: "Kota" },
  ];

  const SEVERITY_FILTERS = [
    { key: "", label: "Semua Severity" },
    { key: "low", label: "Low" },
    { key: "med", label: "Medium" },
    { key: "high", label: "High" },
    { key: "absurd", label: "Absurd" },
  ];

  let dashboardData = null;
  let regionsByKey = new Map();
  let provincesByKey = new Map();

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeJsString(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  function jsArg(value) {
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    if (typeof value === "number") {
      return String(value);
    }
    return `'${escapeJsString(value)}'`;
  }

  function actionCall(action, ...args) {
    return escapeAttr(`dashboardActions.${action}(${args.map(jsArg).join(",")})`);
  }

  function actionExpr(expression) {
    return escapeAttr(expression);
  }

  function normalizeSourceId(sourceId) {
    if (sourceId === null || sourceId === undefined) {
      return null;
    }

    const normalized = String(sourceId).trim();
    if (!/^\d+$/.test(normalized)) {
      return null;
    }

    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return null;
    }

    return String(parsed);
  }

  function buildInaprocUrl(sourceId) {
    const kode = normalizeSourceId(sourceId);
    return kode ? `https://data.inaproc.id/rup?kode=${encodeURIComponent(kode)}` : null;
  }

  function isProvinceView() {
    return state.mapFilter === "provinsi";
  }

  function isCentralOwnerMode() {
    return state.mapFilter === "central";
  }

  function currentAreaType() {
    return isProvinceView() ? "province" : "region";
  }

  function formatCompactCurrency(value) {
    const amount = Number(value) || 0;
    const abs = Math.abs(amount);
    if (abs >= 1e12) return `${(amount / 1e12).toFixed(amount % 1e12 === 0 ? 0 : 1)} T`;
    if (abs >= 1e9) return `${(amount / 1e9).toFixed(amount % 1e9 === 0 ? 0 : 1)} B`;
    if (abs >= 1e6) return `${(amount / 1e6).toFixed(amount % 1e6 === 0 ? 0 : 1)} M`;
    if (abs >= 1e3) return `${(amount / 1e3).toFixed(amount % 1e3 === 0 ? 0 : 1)} K`;
    return `${amount.toFixed(0)}`;
  }

  function formatCurrencyLong(value) {
    const number = Math.round(Number(value) || 0);
    return `Rp ${number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  }

  function formatNumber(value) {
    const number = Math.round(Number(value) || 0);
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function formatDecimal(value) {
    const amount = Number(value) || 0;
    return amount % 1 === 0 ? formatNumber(amount) : amount.toFixed(2).replace(".", ",");
  }

  function ownerTypeLabel(value) {
    if (value === "central") return "Kementerian/Lembaga";
    if (value === "provinsi") return "Pemprov";
    if (value === "kabkota") return "Pemkot";
    if (value === "other") return "Others";
    return "Tidak diketahui";
  }

  function ownerTypeCount(area, ownerType) {
    return Number(area && area.ownerMix ? area.ownerMix[ownerType] : 0) || 0;
  }

  function ownerMixSummary(area) {
    return `K/L ${formatNumber(ownerTypeCount(area, "central"))} | Pemprov ${formatNumber(
      ownerTypeCount(area, "provinsi")
    )} | Pemkot ${formatNumber(ownerTypeCount(area, "kabkota"))} | Others ${formatNumber(
      ownerTypeCount(area, "other")
    )}`;
  }

  function areaOwnerSummary(area) {
    return `${activeSidebarOwnerLabel()} saja`;
  }

  function areaBadgeLabel(area) {
    if (area.regionType === "Provinsi") return "Prov.";
    if (area.regionType === "Kota") return "Kota";
    return "Kab.";
  }

  function areaBadgeClass(area) {
    return area.regionType === "Kota" ? "bk" : "bp";
  }

  function areaSecondaryLine(area) {
    return isProvinceView() ? "Hanya paket Pemprov" : area.provinceName;
  }

  function severityColor(severity) {
    if (severity === "absurd") return "var(--rose)";
    if (severity === "high") return "var(--brick)";
    if (severity === "med") return "var(--olive)";
    return "var(--steel)";
  }

  function severityLabel(severity) {
    if (severity === "absurd") return "Absurd";
    if (severity === "high") return "High";
    if (severity === "med") return "Medium";
    return "Low";
  }

  function totalAreaMetrics(area) {
    return {
      totalPackages: Number(area?.totalPackages) || 0,
      totalPriorityPackages: Number(area?.totalPriorityPackages) || 0,
      totalPotentialWaste: Number(area?.totalPotentialWaste) || 0,
      totalBudget: Number(area?.totalBudget) || 0,
    };
  }

  function getActiveSidebarOwnerKey() {
    return isProvinceView() ? "provinsi" : state.mapFilter;
  }

  function activeSidebarOwnerLabel() {
    return ownerTypeLabel(getActiveSidebarOwnerKey());
  }

  function getAreaMetricsForOwner(area, ownerKey) {
    if (!area) {
      return totalAreaMetrics(null);
    }

    const metrics = area.ownerMetrics && area.ownerMetrics[ownerKey];

    if (metrics) {
      return {
        totalPackages: Number(metrics.totalPackages) || 0,
        totalPriorityPackages: Number(metrics.totalPriorityPackages) || 0,
        totalPotentialWaste: Number(metrics.totalPotentialWaste) || 0,
        totalBudget: Number(metrics.totalBudget) || 0,
      };
    }

    if (isProvinceView() && ownerKey === "provinsi") {
      return totalAreaMetrics(area);
    }

    return {
      totalPackages: ownerTypeCount(area, ownerKey),
      totalPriorityPackages: 0,
      totalPotentialWaste: 0,
      totalBudget: 0,
    };
  }

  function getSidebarAreaMetrics(area) {
    const ownerKey = getActiveSidebarOwnerKey();
    return ownerKey ? getAreaMetricsForOwner(area, ownerKey) : totalAreaMetrics(area);
  }

  function renderSeverityFilterOptions(selectedValue) {
    return SEVERITY_FILTERS.map(
      (filter) =>
        `<option value="${escapeAttr(filter.key)}"${selectedValue === filter.key ? " selected" : ""}>${escapeHtml(
          filter.label
        )}</option>`
    ).join("");
  }

  function getOwnerCardKey(ownerType, ownerName) {
    return `${ownerType}::${ownerName}`;
  }

  function getAreaKey(area, areaType = currentAreaType()) {
    return areaType === "province" ? area.provinceKey : area.regionKey;
  }

  function getAreaByKey(areaType, areaKey) {
    return (areaType === "province" ? provincesByKey : regionsByKey).get(areaKey) || null;
  }

  function getActiveAreaByKey(areaKey) {
    return getAreaByKey(currentAreaType(), areaKey);
  }

  function getActiveAreas() {
    return isProvinceView() ? dashboardData.provinceView.provinces : dashboardData.regions;
  }

  function getCentralOwnersForSidebar() {
    return dashboardData && dashboardData.ownerLists && Array.isArray(dashboardData.ownerLists.central)
      ? dashboardData.ownerLists.central
      : [];
  }

  function getActiveGeo() {
    return isProvinceView() ? dashboardData.provinceView.geo : dashboardData.geo;
  }

  function getActiveLegend() {
    return isProvinceView() ? dashboardData.provinceView.legend : dashboardData.legend;
  }

  function getFeatureAreaKey(feature) {
    return isProvinceView() ? feature.properties.provinceKey : feature.properties.regionKey;
  }

  function ensureMapStatus() {
    let status = document.getElementById("mapStatus");
    if (!status) {
      status = document.createElement("div");
      status.id = "mapStatus";
      status.className = "map-status";
      dom.mapRoot.parentElement.appendChild(status);
    }
    return status;
  }

  function setMapStatus(message, isError) {
    const status = ensureMapStatus();
    status.className = `map-status${isError ? " error" : ""}`;
    status.textContent = message;
  }

  function clearMapStatus() {
    const status = document.getElementById("mapStatus");
    if (status) {
      status.remove();
    }
  }

  function renderKpiCards(cards) {
    dom.kpi.innerHTML = cards
      .map(
        (item) =>
          `<div class="kc"><div class="kl">${escapeHtml(item.label)}</div><div class="kv">${escapeHtml(
            item.value
          )}</div><div class="ks">${escapeHtml(item.sublabel)}</div></div>`
      )
      .join("");
  }

  function renderSidebarMessage(message, isError) {
    dom.sidebarContent.innerHTML = `<div class="panel-msg${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
  }

  function renderModalState(title, message, isError) {
    dom.modalTop.innerHTML =
      `<div class="modal-top-row"><div><h2>${escapeHtml(title)}</h2><div class="msub">Audit paket pengadaan &middot; TA 2026</div></div>` +
      `<div style="display:flex;gap:8px;align-items:center"><button class="modal-close" onclick="${actionCall("closeRegionModal")}">&#10005; Tutup</button></div></div>`;
    dom.modalBody.innerHTML = `<div class="modal-state${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
  }

  function renderBootstrapLoading() {
    renderKpiCards([
      { label: "Total Potensi Pemborosan", value: "...", sublabel: "Menghitung agregat audit" },
      { label: "Paket Prioritas Audit", value: "...", sublabel: "Memuat daftar area" },
      { label: "Total Pagu Teraudit", value: "...", sublabel: "Menyiapkan peta kab/kota dan provinsi" },
      { label: "Paket Terpetakan", value: "...", sublabel: "Memeriksa cakupan lokasi" },
    ]);
    renderSidebarMessage("Memuat audit pengadaan per area...", false);
    setMapStatus("Memuat peta audit...", false);
  }

  function renderBootstrapError(error) {
    renderKpiCards([
      { label: "Total Potensi Pemborosan", value: "-", sublabel: "Backend belum siap" },
      { label: "Paket Prioritas Audit", value: "-", sublabel: "Periksa ingest hasil analyze" },
      { label: "Total Pagu Teraudit", value: "-", sublabel: "Ulangi db:reset bila perlu" },
      { label: "Paket Terpetakan", value: "-", sublabel: "Map belum dapat dibuat" },
    ]);
    renderSidebarMessage(`Gagal memuat dashboard audit: ${error}`, true);
    setMapStatus(`Gagal memuat dashboard audit: ${error}`, true);
  }

  function formatFetchError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function fetchJson(path) {
    const response = await fetch(`${API_BASE_URL}${path}`);
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        throw new Error(`Invalid JSON response from ${path}`);
      }
    }
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : `Request failed (${response.status})`);
    }
    return payload;
  }

  function normalizeDashboardData(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Bootstrap payload tidak valid.");
    }
    // 👇 MODIFIKASI: Filter GeoJSON agar hanya berisi Kabupaten Bandung 👇
    if (payload.geo && Array.isArray(payload.geo.features)) {
      payload.geo.features = payload.geo.features.filter(feature => {
        const name = feature.properties.regionName || feature.properties.displayName || "";
        // Hanya simpan yang ada kata "Bandung" tapi tidak ada kata "Barat"
        return name.includes("Bandung") && !name.includes("Barat");
      });
    }
    // 👆 SELESAI MODIFIKASI 👆

    return {
      summary: payload.summary || {
        totalPackages: 0,
        totalPriorityPackages: 0,
        totalPotentialWaste: 0,
        totalBudget: 0,
        unmappedPackages: 0,
        multiLocationPackages: 0,
      },
      legend: payload.legend || { zeroColor: "#243155", ranges: [] },
      geo: payload.geo || { type: "FeatureCollection", features: [] },
      regions: Array.isArray(payload.regions) ? payload.regions : [],
      provinceView: {
        legend: (payload.provinceView && payload.provinceView.legend) || { zeroColor: "#243155", ranges: [] },
        geo: (payload.provinceView && payload.provinceView.geo) || { type: "FeatureCollection", features: [] },
        provinces:
          payload.provinceView && Array.isArray(payload.provinceView.provinces) ? payload.provinceView.provinces : [],
      },
      ownerLists: {
        central: payload.ownerLists && Array.isArray(payload.ownerLists.central) ? payload.ownerLists.central : [],
      },
    };
  }

  function getLegendColor(value) {
    const legend = getActiveLegend();

    if (!legend) {
      return "#243155";
    }

    if (!value || value <= 0) {
      return legend.zeroColor || "#243155";
    }

    const range = (legend.ranges || []).find((item) => value >= item.min && value <= item.max);
    return range ? range.color : legend.ranges[legend.ranges.length - 1]?.color || "#a83c2e";
  }

  function areaMatchesCurrentView(area) {
    if (!area) {
      return false;
    }

    if (isProvinceView()) {
      return area.totalPackages > 0;
    }

    if (state.tab === "kabupaten" && area.regionType !== "Kabupaten") {
      return false;
    }

    if (state.tab === "kota" && area.regionType !== "Kota") {
      return false;
    }

    if (FILTERS.some((filter) => filter.key === state.mapFilter)) {
      return ownerTypeCount(area, state.mapFilter) > 0;
    }

    return true;
  }

  function getFilteredAreasForSidebar() {
    let areas = getActiveAreas().filter((area) => areaMatchesCurrentView(area));

    if (state.search) {
      const query = state.search.toLowerCase();
      const activeOwnerQuery = activeSidebarOwnerLabel().toLowerCase();
      areas = areas.filter((area) => {
        const matchesName = area.displayName.toLowerCase().includes(query) || area.provinceName.toLowerCase().includes(query);

        if (isProvinceView()) {
          return matchesName;
        }

        return matchesName || activeOwnerQuery.includes(query);
      });
    }

    const metricsByAreaKey = new Map(areas.map((area) => [getAreaKey(area), getSidebarAreaMetrics(area)]));
    const sorters = {
      waste: (left, right) =>
        metricsByAreaKey.get(getAreaKey(right)).totalPotentialWaste - metricsByAreaKey.get(getAreaKey(left)).totalPotentialWaste,
      priority: (left, right) =>
        metricsByAreaKey.get(getAreaKey(right)).totalPriorityPackages - metricsByAreaKey.get(getAreaKey(left)).totalPriorityPackages,
      packages: (left, right) =>
        metricsByAreaKey.get(getAreaKey(right)).totalPackages - metricsByAreaKey.get(getAreaKey(left)).totalPackages,
      budget: (left, right) =>
        metricsByAreaKey.get(getAreaKey(right)).totalBudget - metricsByAreaKey.get(getAreaKey(left)).totalBudget,
    };

    return areas.sort((left, right) => {
      const primary = (sorters[state.sortBy] || sorters.waste)(left, right);
      return primary !== 0 ? primary : left.displayName.localeCompare(right.displayName, "id");
    });
  }

  function getFilteredOwnersForSidebar() {
    let owners = getCentralOwnersForSidebar().slice();

    if (state.search) {
      const query = state.search.toLowerCase();
      owners = owners.filter((owner) => owner.ownerName.toLowerCase().includes(query));
    }

    const sorters = {
      waste: (left, right) => right.totalPotentialWaste - left.totalPotentialWaste,
      priority: (left, right) => right.totalPriorityPackages - left.totalPriorityPackages,
      packages: (left, right) => right.totalPackages - left.totalPackages,
      budget: (left, right) => right.totalBudget - left.totalBudget,
    };

    return owners.sort((left, right) => {
      const primary = (sorters[state.sortBy] || sorters.waste)(left, right);
      return primary !== 0 ? primary : left.ownerName.localeCompare(right.ownerName, "id");
    });
  }

  function renderKpis() {
    const summary = dashboardData.summary;
    const mappedPackages = summary.totalPackages - summary.unmappedPackages;

    renderKpiCards([
      {
        label: "Total Potensi Pemborosan",
        value: `Rp ${formatCompactCurrency(summary.totalPotentialWaste)}`,
        sublabel: "Nilai khusus wilayah Kabupaten Bandung",
      },
      {
        label: "Paket Prioritas Audit",
        value: formatNumber(summary.totalPriorityPackages),
        sublabel: `${formatNumber(summary.totalPackages)} paket teraudit`,
      },
      {
        label: "Total Pagu Teraudit",
        value: `Rp ${formatCompactCurrency(summary.totalBudget)}`,
        sublabel: "Akumulasi pagu dari instansi Pemkab Bandung",
      },
      {
        label: "Paket Terpetakan",
        value: `${formatNumber(mappedPackages)} / ${formatNumber(summary.totalPackages)}`,
        sublabel: `${formatNumber(summary.unmappedPackages)} unmapped | ${formatNumber(summary.multiLocationPackages)} multi-lokasi`,
      },
    ]);
  }

  function renderLegend() {
    dom.legend.style.display = "none";
    const legend = getActiveLegend();
    const title = isProvinceView()
      ? "Potensi Pemborosan Paket Pemprov per Provinsi"
      : "Potensi Pemborosan per Kab/Kota";
    const zeroLabel = isProvinceView() ? "Tidak ada paket pemprov terdeteksi" : "Tidak ada potensi terdeteksi";
    const note = isProvinceView()
      ? "Agregasi provinsi mendeduplikasi paket multi-kab/kota di provinsi yang sama."
      : "Map region menghitung penuh paket multi-lokasi, sehingga agregat region bisa lebih besar dari KPI nasional.";
    const rows = [
      `<div class="lt">${escapeHtml(title)}</div>`,
      `<div class="li"><div class="lsw" style="background:${escapeAttr(legend.zeroColor || "#243155")}"></div> ${escapeHtml(
        zeroLabel
      )}</div>`,
    ];

    (legend.ranges || []).forEach((range) => {
      rows.push(
        `<div class="li"><div class="lsw" style="background:${escapeAttr(range.color)}"></div> Rp ${escapeHtml(
          formatCompactCurrency(range.min)
        )} &ndash; Rp ${escapeHtml(formatCompactCurrency(range.max))}</div>`
      );
    });

    rows.push(`<div class="legend-note">${escapeHtml(note)}</div>`);
    dom.legend.innerHTML = rows.join("");
  }

  function renderFilterChips() {
    dom.mapFilters.style.display = "none";
    dom.mapFilters.innerHTML = FILTERS.map(
      (filter) =>
        `<div class="fc${filter.key === state.mapFilter ? " a" : ""}" onclick="${actionCall("setMapFilter", filter.key)}">${escapeHtml(
          filter.label
        )}</div>`
    ).join("");
  }

  function renderTabs() {
    dom.tabs.style.display = "none";
    const provinceView = isProvinceView();
    const centralOwnerMode = isCentralOwnerMode();

    dom.tabs.innerHTML = TABS.map((tab) => {
      const active = provinceView || centralOwnerMode ? tab.key === "all" : tab.key === state.tab;
      const disabled = (provinceView || centralOwnerMode) && tab.key !== "all";

      return `<button class="stb${active ? " a" : ""}"${disabled ? " disabled" : ""} onclick="${actionCall(
        "setTab",
        disabled ? "all" : tab.key
      )}">${escapeHtml(tab.label)}</button>`;
    }).join("");
  }

  function sortControl() {
    const placeholder = isCentralOwnerMode()
      ? "Cari kementerian/lembaga..."
      : isProvinceView()
      ? "Cari provinsi..."
      : "Cari kabupaten/kota...";

    return (
      `<div class="sw"><span class="si">&#128269;</span><input type="text" placeholder="${escapeAttr(
        placeholder
      )}" value="${escapeAttr(state.search)}" oninput="${actionExpr("dashboardActions.setSearch(this.value)")}" /></div>` +
      `<div class="sort-bar"><label>Urutkan</label><select onchange="${actionExpr("dashboardActions.setSort(this.value)")}" aria-label="Urutkan area">` +
      `<option value="waste"${state.sortBy === "waste" ? " selected" : ""}>Potensi Pemborosan</option>` +
      `<option value="priority"${state.sortBy === "priority" ? " selected" : ""}>Paket Prioritas</option>` +
      `<option value="packages"${state.sortBy === "packages" ? " selected" : ""}>Total Paket</option>` +
      `<option value="budget"${state.sortBy === "budget" ? " selected" : ""}>Total Pagu</option>` +
      `</select></div>`
    );
  }

  function renderOwnerSidebarContent() {
    const owners = getFilteredOwnersForSidebar();

    if (!owners.length) {
      dom.sidebarContent.innerHTML =
        sortControl() + `<div class="panel-msg">Tidak ada kementerian/lembaga yang cocok dengan filter saat ini.</div>`;
      return;
    }

    const maxWaste = Math.max(...owners.map((owner) => owner.totalPotentialWaste), 1);

    dom.sidebarContent.innerHTML =
      sortControl() +
      owners
        .map((owner, index) => {
          const selectedClass =
            state.selectedOwnerKey === getOwnerCardKey(owner.ownerType, owner.ownerName) ? " a" : "";

          return (
            `<div class="pi${selectedClass}" onclick="${actionCall("openOwnerModal", owner.ownerName, owner.ownerType)}">` +
            `<div class="pit"><div class="pn"><span style="color:var(--t3);font-size:9px;margin-right:5px">#${index + 1}</span>${escapeHtml(
              owner.ownerName
            )}</div><div class="tbd bc">K/L</div></div>` +
            `<div style="font-size:9.5px;color:var(--t3);margin-bottom:4px">Kementerian/Lembaga</div>` +
            `<div><span class="ppv">Rp ${escapeHtml(formatCompactCurrency(owner.totalPotentialWaste))}</span><span class="ppl"> &middot; ${escapeHtml(
              formatNumber(owner.totalPriorityPackages)
            )} prioritas</span></div>` +
            `<div class="bw"><div class="bf" style="width:${Math.max(
              4,
              Math.round((owner.totalPotentialWaste / maxWaste) * 100)
            )}%;background:${escapeAttr(getLegendColor(owner.totalPotentialWaste))}"></div></div>` +
            `<div class="ps"><div class="pst">Total Paket: <strong>${escapeHtml(
              formatNumber(owner.totalPackages)
            )}</strong></div><div class="pst">Severity High: <strong>${escapeHtml(
              formatNumber(owner.severityCounts.high)
            )}</strong></div></div>` +
            `<div class="owner-mix">Severity Absurd ${escapeHtml(formatNumber(owner.severityCounts.absurd))}</div>` +
            `<div class="waste-row"><span class="waste-label">Pagu Teraudit</span><span class="waste-val">${escapeHtml(
              `Rp ${formatCompactCurrency(owner.totalBudget)}`
            )}</span></div>` +
            `</div>`
          );
        })
        .join("");
  }

function renderSidebarContent() {
    // Membajak sidebar untuk dijadikan Panel Inovasi Daerah
    dom.sidebarContent.innerHTML = `
      <div style="padding: 15px;">
          <div style="font-size: 11px; color: var(--t3); text-transform: uppercase; letter-spacing: 1px; font-weight: bold; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid var(--b2);">
               Panel 
          </div>

          <div class="pi" onclick="bukaDeteksiAnomali()" style="cursor: pointer; border-left: 4px solid var(--brick); background: rgba(168,60,46,0.05);">
              <div class="pit"><div class="pn" style="font-size: 14px; color: #f0d8a8;">Deteksi Anomali ATK dan Makan/Minum</div></div>
              <div style="font-size:11.5px; color:var(--t1); margin-top:8px; line-height: 1.4;">
                  Sistem filter otomatis mendeteksi paket berisiko tinggi:<br>
                  <span style="color: var(--t3);">&bull; Makan/Minum > Rp 200 Juta<br>&bull; ATK > Rp 100 Juta</span>
              </div>
          </div>

          <div class="pi" onclick="bukaRoroJonggrang()" style="cursor: pointer; border-left: 4px solid var(--rose); background: rgba(212,169,153,0.05); margin-top: 15px;">
              <div class="pit"><div class="pn" style="font-size: 14px; color: #f0d8a8;">Detektor Proyek Akhir Tahun</div></div>
              <div style="font-size:11.5px; color:var(--t1); margin-top:8px; line-height: 1.4;">
                  Mendeteksi otomatis proyek fisik/konstruksi bernilai > Rp 1 Miliar yang rawan mark-up jika dikebut di akhir tahun.
              </div>
          </div>

          <div class="pi" onclick="bukaPerjalananDinas()" style="cursor: pointer; border-left: 4px solid var(--sage); background: rgba(123,134,163,0.05); margin-top: 15px;">
              <div class="pit"><div class="pn" style="font-size: 14px; color: #f0d8a8;">Detektor Perjalanan Dinas</div></div>
              <div style="font-size:11.5px; color:var(--t1); margin-top:8px; line-height: 1.4;">
                  Mengawasi paket perjalanan dinas, kunjungan kerja, atau rapat koordinasi dengan anggaran fantastis (> Rp 300 Jt).
              </div>
          </div>

          <div class="pi" onclick="bukaRekomendasiUMKM()" style="cursor: pointer; border-left: 4px solid var(--gold); background: rgba(181,168,130,0.05); margin-top: 15px;">
              <div class="pit"><div class="pn" style="font-size: 14px; color: #f0d8a8;">Potensi UMKM Terdekat</div></div>
              <div style="font-size:11.5px; color:var(--t1); margin-top:8px; line-height: 1.4;">
                  Rekomendasi UMKM Lokal di wilayah Kab. Bandung yang berpotensi dan dapat menjadi penyuplai proyek pemerintah.
              </div>
          </div>

          <div class="pi" onclick="bukaGrafikAnggaran()" style="cursor: pointer; border-left: 4px solid var(--t2); background: rgba(123,134,163,0.05); margin-top: 15px;">
              <div class="pit"><div class="pn" style="font-size: 14px; color: #f0d8a8;"> Analisis Pagu OPD</div></div>
              <div style="font-size:11.5px; color:var(--t1); margin-top:8px; line-height: 1.4;">
                  Visualisasi postur anggaran berdasarkan instansi/dinas untuk melihat fokus pembangunan daerah.
              </div>
          </div>
      </div>
    `;
  }

  function featureStyle(feature) {
    const areaKey = getFeatureAreaKey(feature);
    const area = getActiveAreaByKey(areaKey);
    const visible = areaMatchesCurrentView(area);
    const selected = state.selectedAreaKey === areaKey;
    const strokeOpacity = (selected ? 1 : 0.2) * (visible ? 0.85 : 0.2);

    return {
      fillColor: area ? getLegendColor(area.totalPotentialWaste) : "#243155",
      fillOpacity: selected ? 0.72 : visible ? 0.52 : 0.08,
      strokeColor: selected ? "#f0d8a8" : "#b5a882",
      strokeWidth: selected ? 2.1 : 0.8,
      strokeOpacity,
    };
  }

  function popupHtml(area) {
    if (!area) {
      return `<div class="pt">Belum ada data</div>`;
    }

    if (isProvinceView()) {
      return (
        `<div class="pt">${escapeHtml(area.displayName)}</div>` +
        `<div class="popup-sub">Paket Pemprov</div>` +
        `<div class="pr"><span class="l">Potensi Pemborosan</span><span class="v" style="color:#b5a882">Rp ${escapeHtml(
          formatCompactCurrency(area.totalPotentialWaste)
        )}</span></div>` +
        `<div class="pr"><span class="l">Paket Prioritas</span><span class="v">${escapeHtml(
          formatNumber(area.totalPriorityPackages)
        )}</span></div>` +
        `<div class="pr"><span class="l">Total Paket</span><span class="v">${escapeHtml(
          formatNumber(area.totalPackages)
        )}</span></div>` +
        `<div class="pr"><span class="l">Total Pagu</span><span class="v">${escapeHtml(
          formatCompactCurrency(area.totalBudget)
        )}</span></div>` +
        `<div class="pr"><span class="l">Severity High</span><span class="v">${escapeHtml(
          formatNumber(area.severityCounts.high)
        )}</span></div>` +
        `<div class="ppb"><div class="ppbf" style="width:${Math.min(
          100,
          area.totalPriorityPackages > 0 ? Math.round((area.totalPriorityPackages / Math.max(area.totalPackages, 1)) * 100) : 0
        )}%;background:${escapeAttr(getLegendColor(area.totalPotentialWaste))}"></div></div>`
      );
    }

    return (
      `<div class="pt">${escapeHtml(area.displayName)}</div>` +
      `<div class="popup-sub">${escapeHtml(area.provinceName)}</div>` +
      `<div class="pr"><span class="l">Potensi Pemborosan</span><span class="v" style="color:#b5a882">Rp ${escapeHtml(
        formatCompactCurrency(area.totalPotentialWaste)
      )}</span></div>` +
      `<div class="pr"><span class="l">Paket Prioritas</span><span class="v">${escapeHtml(
        formatNumber(area.totalPriorityPackages)
      )}</span></div>` +
      `<div class="pr"><span class="l">Total Paket</span><span class="v">${escapeHtml(
        formatNumber(area.totalPackages)
      )}</span></div>` +
      `<div class="pr"><span class="l">Kementerian/Lembaga</span><span class="v">${escapeHtml(
        formatNumber(ownerTypeCount(area, "central"))
      )}</span></div>` +
      `<div class="pr"><span class="l">Pemprov</span><span class="v">${escapeHtml(
        formatNumber(ownerTypeCount(area, "provinsi"))
      )}</span></div>` +
      `<div class="pr"><span class="l">Pemkot</span><span class="v">${escapeHtml(
        formatNumber(ownerTypeCount(area, "kabkota"))
      )}</span></div>` +
      `<div class="pr"><span class="l">Others</span><span class="v">${escapeHtml(
        formatNumber(ownerTypeCount(area, "other"))
      )}</span></div>` +
      `<div class="ppb"><div class="ppbf" style="width:${Math.min(
        100,
        area.totalPriorityPackages > 0 ? Math.round((area.totalPriorityPackages / Math.max(area.totalPackages, 1)) * 100) : 0
      )}%;background:${escapeAttr(getLegendColor(area.totalPotentialWaste))}"></div></div>`
    );
  }

  function renderGeoLayer(fitToBounds) {
    const geo = getActiveGeo();

    if (!geo || !Array.isArray(geo.features) || !geo.features.length) {
      setMapStatus("Tidak ada geometri untuk mode peta saat ini.", true);
      return;
    }

    AuditMap.render(
      dom.mapRoot,
      geo,
      {
        getFeatureStyle: featureStyle,
        getPopupHtml: (areaKey) => popupHtml(getActiveAreaByKey(areaKey)),
        onAreaClick: openAreaModal,
        fitBounds: fitToBounds,
        isProvinceView: isProvinceView(),
      },
      clearMapStatus
    );
  }

  function initMap() {
    renderGeoLayer(true);
  }

  function refreshMapStyles() {
    AuditMap.refresh(getActiveGeo(), featureStyle);
  }

  function renderPackageTableRows(items) {
    return items.length
      ? items
          .map((item) => {
            const packageUrl = buildInaprocUrl(item.sourceId);

           // 👇 OTAK DETEKTIF FRONTTEND (UPDATE RORO JONGGRANG) 👇
            const namaPaket = (item.packageName || "").toLowerCase();
            const pagu = Number(item.budget) || 0;
            
            let isAnomali = false;
            let alasanAnomali = "";
            let warnaTeks = "#dc3545"; // Default merah bata
            let warnaBackground = "rgba(220, 53, 69, 0.15)";

            // 1. Deteksi ATK
            if (namaPaket.includes("atk") && pagu > 100000000) {
                isAnomali = true;
                alasanAnomali = "⚠️ Anomali Lokal: Pagu belanja ATK sangat tinggi (> Rp 100 Jt)";
            } 
            // 2. Deteksi Makan/Minum
            else if ((namaPaket.includes("makan") || namaPaket.includes("minum")) && pagu > 200000000) {
                isAnomali = true;
                alasanAnomali = "⚠️ Anomali Lokal: Pagu Makan/Minum fantastis (> Rp 200 Jt)";
            }
            // 3. Deteksi Roro Jonggrang (Baru!)
            else if ((namaPaket.includes("pembangunan") || namaPaket.includes("rehabilitasi")) && pagu > 1000000000) {
                isAnomali = true;
                alasanAnomali = "⏱️ Rawan Pengerjaan Akhir Tahun: Proyek fisik raksasa (> Rp 1 Miliar). Waspada pengerjaan akhir tahun!";
                warnaTeks = "#d4a999"; // Warna Peach/Rose khas Nemesis
                warnaBackground = "rgba(212, 169, 153, 0.15)";
            }
            else if ((namaPaket.includes("perjalanan dinas") || namaPaket.includes("kunjungan") || namaPaket.includes("rapat")) && pagu > 300000000) {
                isAnomali = true;
                alasanAnomali = "✈️ Indikasi Pemborosan: Anggaran Perjalanan Dinas / Rapat Koordinasi sangat tinggi (> Rp 300 Jt).";
                warnaTeks = "#7b86a3"; // Warna Biru Nemesis (Sage)
                warnaBackground = "rgba(123, 134, 163, 0.2)"; // Latar Biru transparan
            }

            const rowStyle = isAnomali ? ` style="background-color: ${warnaBackground};"` : '';
            const customReason = isAnomali ? `<div style="color: ${warnaTeks}; font-weight: bold; margin-bottom: 8px;">${escapeHtml(alasanAnomali)}</div>` : '';
            // 👆 AKHIR OTAK DETEKTIF 👆

            return (
              `<tr${
                packageUrl
                  ? ` class="package-row-link" tabindex="0" role="link" aria-label="${escapeAttr(
                      `Buka ${item.packageName} di Inaproc`
                    )}" onclick="${actionCall("openPackageDetail", item.sourceId)}" onkeydown="${actionExpr(
                      `dashboardActions.handlePackageRowKeydown(event, ${jsArg(item.sourceId)})`
                    )}"`
                  : ""
              }${rowStyle}>` + 
              `<td class="mono">${escapeHtml(String(item.sourceId || item.id))}</td>` +
              `<td class="pkg">${escapeHtml(item.packageName)}</td>` +
              `<td><div class="tbl-owner">${escapeHtml(item.ownerName)}</div><div class="tbl-sub">${escapeHtml(
                ownerTypeLabel(item.ownerType)
              )}</div></td>` +
              `<td><div class="tbl-owner">${escapeHtml(item.satker || "-")}</div><div class="tbl-sub">${escapeHtml(
                item.locationRaw || "-"
              )}</div></td>` +
              `<td class="mono" style="color:var(--sage)">${escapeHtml(item.budget === null ? "-" : formatCurrencyLong(item.budget))}</td>` +
              `<td><span class="sev-b" style="background:${escapeAttr(
                item.audit.severity === "absurd"
                  ? "rgba(212,169,153,.18)"
                  : item.audit.severity === "high"
                  ? "rgba(168,60,46,.16)"
                  : item.audit.severity === "med"
                    ? "rgba(139,115,50,.16)"
                    : "rgba(123,134,163,.16)"
              )};color:${escapeAttr(severityColor(item.audit.severity))}">${escapeHtml(
                severityLabel(item.audit.severity)
              )}</span></td>` +
              `<td class="reason">${customReason}${escapeHtml(item.audit.reason || "-")}</td>` +
              `</tr>`
            );
          })
          .join("")
      : `<tr><td colspan="7" class="table-empty">Tidak ada paket untuk filter saat ini.</td></tr>`;
  }

  function renderPagination(pagination) {
    return (
      `<div class="pager"><button class="pager-btn" ${pagination.page <= 1 ? "disabled" : ""} onclick="${actionCall(
        "changeModalPage",
        pagination.page - 1
      )}">Sebelumnya</button><div class="pager-text">Halaman ${escapeHtml(formatNumber(pagination.page))} / ${escapeHtml(
        formatNumber(pagination.totalPages)
      )} &middot; ${escapeHtml(formatNumber(pagination.totalItems))} paket</div><button class="pager-btn" ${
        pagination.page >= pagination.totalPages ? "disabled" : ""
      } onclick="${actionCall("changeModalPage", pagination.page + 1)}">Berikutnya</button></div>`
    );
  }

  function renderRegionModalContent(payload) {
    const region = payload.region;
    const rowsHtml = renderPackageTableRows(payload.items);

    dom.modalTop.innerHTML =
      `<div class="modal-top-row"><div><h2>${escapeHtml(region.displayName)}</h2><div class="msub">${escapeHtml(
        `${region.provinceName} | Audit paket pengadaan TA 2026`
      )}</div></div>` +
      `<div style="display:flex;gap:8px;align-items:center"><span class="tbd ${areaBadgeClass(region)}">${escapeHtml(
        region.regionType
      )}</span><button class="modal-close" onclick="${actionCall(
        "closeRegionModal"
      )}">&#10005; Tutup</button></div></div>` +
      `<div class="modal-kpis">` +
      `<div class="mkp"><div class="mkp-l">Potensi Pemborosan</div><div class="mkp-v" style="color:var(--brick)">Rp ${escapeHtml(
        formatCompactCurrency(region.totalPotentialWaste)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Paket Prioritas</div><div class="mkp-v">${escapeHtml(
        formatNumber(region.totalPriorityPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Paket</div><div class="mkp-v">${escapeHtml(
        formatNumber(region.totalPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Pagu</div><div class="mkp-v" style="color:var(--sage)">Rp ${escapeHtml(
        formatCompactCurrency(region.totalBudget)
      )}</div></div></div>`;

    dom.modalBody.innerHTML =
      `<div class="modal-summary-grid">` +
      `<div class="mini-stat"><span>Kementerian/Lembaga</span><strong>${escapeHtml(
        formatNumber(ownerTypeCount(region, "central"))
      )}</strong></div>` +
      `<div class="mini-stat"><span>Pemprov</span><strong>${escapeHtml(
        formatNumber(ownerTypeCount(region, "provinsi"))
      )}</strong></div>` +
      `<div class="mini-stat"><span>Pemkot</span><strong>${escapeHtml(
        formatNumber(ownerTypeCount(region, "kabkota"))
      )}</strong></div>` +
      `<div class="mini-stat"><span>Others</span><strong>${escapeHtml(
        formatNumber(ownerTypeCount(region, "other"))
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity High</span><strong>${escapeHtml(formatNumber(region.severityCounts.high))}</strong></div>` +
      `<div class="mini-stat"><span>Severity Absurd</span><strong>${escapeHtml(
        formatNumber(region.severityCounts.absurd)
      )}</strong></div>` +
      `</div>` +
      `<div class="modal-filters">` +
      `<input type="text" placeholder="Cari paket, lembaga, atau satker..." value="${escapeAttr(
        state.modal.search
      )}" oninput="${actionExpr("dashboardActions.setModalSearch(this.value)")}" />` +
      `<select onchange="${actionExpr("dashboardActions.setModalOwnerType(this.value)")}" aria-label="Filter jenis pemilik">` +
      `<option value="">Semua Pemilik</option><option value="central"${state.modal.ownerType === "central" ? " selected" : ""}>Kementerian/Lembaga</option>` +
      `<option value="provinsi"${state.modal.ownerType === "provinsi" ? " selected" : ""}>Pemprov</option><option value="kabkota"${
        state.modal.ownerType === "kabkota" ? " selected" : ""
      }>Pemkot</option><option value="other"${
        state.modal.ownerType === "other" ? " selected" : ""
      }>Others</option></select>` +
      `<select onchange="${actionExpr("dashboardActions.setModalSeverity(this.value)")}" aria-label="Filter severity">${renderSeverityFilterOptions(
        state.modal.severity
      )}</select>` +
      `<label class="chk"><input type="checkbox" ${state.modal.priorityOnly ? "checked" : ""} onchange="${actionExpr(
        "dashboardActions.setModalPriorityOnly(this.checked)"
      )}" /> Hanya prioritas</label>` +
      `</div>` +
      `<div class="modal-cnt">Menampilkan ${escapeHtml(formatNumber(payload.items.length))} dari ${escapeHtml(
        formatNumber(payload.pagination.totalItems)
      )} paket pada area ini</div>` +
      `<table class="rtbl"><thead><tr><th>ID</th><th>Nama Paket</th><th>Pemilik</th><th>Satker / Lokasi</th><th>Pagu</th><th>Severity</th><th>Alasan</th></tr></thead><tbody>${rowsHtml}</tbody></table>` +
      renderPagination(payload.pagination);
  }

  function renderProvinceModalContent(payload) {
    const province = payload.province;
    const rowsHtml = renderPackageTableRows(payload.items);

    dom.modalTop.innerHTML =
      `<div class="modal-top-row"><div><h2>${escapeHtml(province.displayName)}</h2><div class="msub">Paket pemprov pada provinsi ini &middot; TA 2026</div></div>` +
      `<div style="display:flex;gap:8px;align-items:center"><span class="tbd ${areaBadgeClass(province)}">Provinsi</span><button class="modal-close" onclick="${actionCall(
        "closeRegionModal"
      )}">&#10005; Tutup</button></div></div>` +
      `<div class="modal-kpis">` +
      `<div class="mkp"><div class="mkp-l">Potensi Pemborosan</div><div class="mkp-v" style="color:var(--brick)">Rp ${escapeHtml(
        formatCompactCurrency(province.totalPotentialWaste)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Paket Prioritas</div><div class="mkp-v">${escapeHtml(
        formatNumber(province.totalPriorityPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Paket Pemprov</div><div class="mkp-v">${escapeHtml(
        formatNumber(province.totalPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Pagu</div><div class="mkp-v" style="color:var(--sage)">Rp ${escapeHtml(
        formatCompactCurrency(province.totalBudget)
      )}</div></div></div>`;

    dom.modalBody.innerHTML =
      `<div class="modal-summary-grid">` +
      `<div class="mini-stat"><span>Paket Flagged</span><strong>${escapeHtml(
        formatNumber(province.totalFlaggedPackages)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity Medium</span><strong>${escapeHtml(
        formatNumber(province.severityCounts.med)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity High</span><strong>${escapeHtml(
        formatNumber(province.severityCounts.high)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity Absurd</span><strong>${escapeHtml(
        formatNumber(province.severityCounts.absurd)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Avg Risk Score</span><strong>${escapeHtml(
        formatDecimal(province.avgRiskScore)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Max Risk Score</span><strong>${escapeHtml(
        formatNumber(province.maxRiskScore)
      )}</strong></div>` +
      `</div>` +
      `<div class="modal-filters">` +
      `<input type="text" placeholder="Cari paket, lembaga, atau satker..." value="${escapeAttr(
        state.modal.search
      )}" oninput="${actionExpr("dashboardActions.setModalSearch(this.value)")}" />` +
      `<select onchange="${actionExpr("dashboardActions.setModalSeverity(this.value)")}" aria-label="Filter severity">${renderSeverityFilterOptions(
        state.modal.severity
      )}</select>` +
      `<label class="chk"><input type="checkbox" ${state.modal.priorityOnly ? "checked" : ""} onchange="${actionExpr(
        "dashboardActions.setModalPriorityOnly(this.checked)"
      )}" /> Hanya prioritas</label>` +
      `</div>` +
      `<div class="modal-cnt">Menampilkan ${escapeHtml(formatNumber(payload.items.length))} dari ${escapeHtml(
        formatNumber(payload.pagination.totalItems)
      )} paket pemprov pada provinsi ini</div>` +
      `<table class="rtbl"><thead><tr><th>ID</th><th>Nama Paket</th><th>Pemilik</th><th>Satker / Lokasi</th><th>Pagu</th><th>Severity</th><th>Alasan</th></tr></thead><tbody>${rowsHtml}</tbody></table>` +
      renderPagination(payload.pagination);
  }

  function renderOwnerModalContent(payload) {
    const owner = payload.owner;
    const rowsHtml = renderPackageTableRows(payload.items);

    dom.modalTop.innerHTML =
      `<div class="modal-top-row"><div><h2>${escapeHtml(owner.ownerName)}</h2><div class="msub">${escapeHtml(
        `${ownerTypeLabel(owner.ownerType)} | Audit paket nasional TA 2026`
      )}</div></div>` +
      `<div style="display:flex;gap:8px;align-items:center"><span class="tbd bc">K/L</span><button class="modal-close" onclick="${actionCall(
        "closeRegionModal"
      )}">&#10005; Tutup</button></div></div>` +
      `<div class="modal-kpis">` +
      `<div class="mkp"><div class="mkp-l">Potensi Pemborosan</div><div class="mkp-v" style="color:var(--brick)">Rp ${escapeHtml(
        formatCompactCurrency(owner.totalPotentialWaste)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Paket Prioritas</div><div class="mkp-v">${escapeHtml(
        formatNumber(owner.totalPriorityPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Paket</div><div class="mkp-v">${escapeHtml(
        formatNumber(owner.totalPackages)
      )}</div></div>` +
      `<div class="mkp"><div class="mkp-l">Total Pagu</div><div class="mkp-v" style="color:var(--sage)">Rp ${escapeHtml(
        formatCompactCurrency(owner.totalBudget)
      )}</div></div></div>`;

    dom.modalBody.innerHTML =
      `<div class="modal-summary-grid">` +
      `<div class="mini-stat"><span>Paket Flagged</span><strong>${escapeHtml(
        formatNumber(owner.totalFlaggedPackages)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity Medium</span><strong>${escapeHtml(
        formatNumber(owner.severityCounts.med)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity High</span><strong>${escapeHtml(
        formatNumber(owner.severityCounts.high)
      )}</strong></div>` +
      `<div class="mini-stat"><span>Severity Absurd</span><strong>${escapeHtml(
        formatNumber(owner.severityCounts.absurd)
      )}</strong></div>` +
      `</div>` +
      `<div class="modal-filters">` +
      `<input type="text" placeholder="Cari paket atau satker..." value="${escapeAttr(
        state.modal.search
      )}" oninput="${actionExpr("dashboardActions.setModalSearch(this.value)")}" />` +
      `<select onchange="${actionExpr("dashboardActions.setModalSeverity(this.value)")}" aria-label="Filter severity">${renderSeverityFilterOptions(
        state.modal.severity
      )}</select>` +
      `<label class="chk"><input type="checkbox" ${state.modal.priorityOnly ? "checked" : ""} onchange="${actionExpr(
        "dashboardActions.setModalPriorityOnly(this.checked)"
      )}" /> Hanya prioritas</label>` +
      `</div>` +
      `<div class="modal-cnt">Menampilkan ${escapeHtml(formatNumber(payload.items.length))} dari ${escapeHtml(
        formatNumber(payload.pagination.totalItems)
      )} paket pada pemilik ini</div>` +
      `<table class="rtbl"><thead><tr><th>ID</th><th>Nama Paket</th><th>Pemilik</th><th>Satker / Lokasi</th><th>Pagu</th><th>Severity</th><th>Alasan</th></tr></thead><tbody>${rowsHtml}</tbody></table>` +
      renderPagination(payload.pagination);
  }

  function renderModalContent(payload) {
    if (state.modal.areaType === "owner") {
      renderOwnerModalContent(payload);
      return;
    }

    if (state.modal.areaType === "province") {
      renderProvinceModalContent(payload);
      return;
    }

    renderRegionModalContent(payload);
  }

  async function loadAreaPackages() {
    if (
      (state.modal.areaType === "owner" && (!state.modal.ownerType || !state.modal.ownerName)) ||
      (state.modal.areaType !== "owner" && !state.modal.areaKey)
    ) {
      return;
    }

    state.modalRequestId += 1;
    const requestId = state.modalRequestId;
    renderModalState(
      state.modal.areaType === "owner" ? "Memuat pemilik..." : "Memuat area...",
      state.modal.areaType === "owner"
        ? "Mengambil paket dari pemilik terpilih..."
        : "Mengambil paket dari backend audit...",
      false
    );

    const params = new URLSearchParams({
      page: String(state.modal.page),
      pageSize: String(state.modal.pageSize),
    });

    if (state.modal.search) {
      params.set("search", state.modal.search);
    }

    if (state.modal.areaType === "region" && state.modal.ownerType) {
      params.set("ownerType", state.modal.ownerType);
    }

    if (state.modal.severity) {
      params.set("severity", state.modal.severity);
    }

    if (state.modal.priorityOnly) {
      params.set("priorityOnly", "true");
    }

    const path =
      state.modal.areaType === "owner"
        ? (() => {
            params.set("ownerType", state.modal.ownerType);
            params.set("ownerName", state.modal.ownerName);
            return `/owners/packages?${params.toString()}`;
          })()
        : state.modal.areaType === "province"
        ? `/provinces/${encodeURIComponent(state.modal.areaKey)}/packages?${params.toString()}`
        : `/regions/${encodeURIComponent(state.modal.areaKey)}/packages?${params.toString()}`;

    try {
      const payload = await fetchJson(path);

      if (requestId !== state.modalRequestId) {
        return;
      }

      renderModalContent(payload);
    } catch (error) {
      if (requestId !== state.modalRequestId) {
        return;
      }

      renderModalState("Gagal memuat paket", formatFetchError(error), true);
    }
  }

  function openAreaModal(areaKey) {
    AuditMap.closePopup();
    state.selectedAreaKey = areaKey;
    state.selectedOwnerKey = null;
    state.modal = {
      areaType: currentAreaType(),
      areaKey,
      ownerName: "",
      page: 1,
      pageSize: 25,
      search: "",
      ownerType: "",
      severity: "",
      priorityOnly: false,
    };

    refreshMapStyles();
    renderSidebarContent();
    dom.modal.classList.add("open");
    document.body.style.overflow = "hidden";
    loadAreaPackages();
  }

  function openOwnerModal(ownerName, ownerType) {
    AuditMap.closePopup();
    state.selectedAreaKey = null;
    state.selectedOwnerKey = getOwnerCardKey(ownerType, ownerName);
    state.modal = {
      areaType: "owner",
      areaKey: null,
      ownerName,
      page: 1,
      pageSize: 25,
      search: "",
      ownerType,
      severity: "",
      priorityOnly: false,
    };

    refreshMapStyles();
    renderSidebarContent();
    dom.modal.classList.add("open");
    document.body.style.overflow = "hidden";
    loadAreaPackages();
  }

  function closeRegionModal() {
    state.modalRequestId += 1;
    state.modal = {
      areaType: currentAreaType(),
      areaKey: null,
      ownerName: "",
      page: 1,
      pageSize: 25,
      search: "",
      ownerType: "",
      severity: "",
      priorityOnly: false,
    };
    dom.modal.classList.remove("open");
    document.body.style.overflow = "";
  }

  function setSearch(value) {
    state.search = value;
    renderSidebarContent();
  }

  function setSort(value) {
    state.sortBy = value;
    renderSidebarContent();
  }

  function setTab(value) {
    if (isProvinceView() || isCentralOwnerMode()) {
      state.tab = "all";
      renderTabs();
      return;
    }

    state.tab = value;
    refreshMapStyles();
    renderTabs();
    renderSidebarContent();
  }

  function setMapFilter(value) {
    const wasProvinceView = isProvinceView();
    const wasCentralOwnerMode = isCentralOwnerMode();
    state.mapFilter = value;
    const viewChanged = wasProvinceView !== isProvinceView();
    const centralOwnerModeChanged = wasCentralOwnerMode !== isCentralOwnerMode();

    if (viewChanged) {
      state.tab = "all";
      state.selectedAreaKey = null;
      state.selectedOwnerKey = null;
      closeRegionModal();
      renderLegend();
      renderFilterChips();
      renderTabs();
      renderSidebarContent();
      renderGeoLayer(true);
      return;
    }

    if (centralOwnerModeChanged) {
      state.tab = "all";
      state.selectedAreaKey = null;
      state.selectedOwnerKey = null;

      if (state.modal.areaType === "owner" && !isCentralOwnerMode()) {
        closeRegionModal();
      }
    }

    refreshMapStyles();
    renderFilterChips();
    renderTabs();
    renderSidebarContent();
  }

  function setModalSearch(value) {
    state.modal.search = value;
    state.modal.page = 1;
    loadAreaPackages();
  }

  function setModalOwnerType(value) {
    if (state.modal.areaType === "province" || state.modal.areaType === "owner") {
      return;
    }

    state.modal.ownerType = value;
    state.modal.page = 1;
    loadAreaPackages();
  }

  function setModalSeverity(value) {
    state.modal.severity = value;
    state.modal.page = 1;
    loadAreaPackages();
  }

  function setModalPriorityOnly(value) {
    state.modal.priorityOnly = Boolean(value);
    state.modal.page = 1;
    loadAreaPackages();
  }

  function changeModalPage(page) {
    state.modal.page = page;
    loadAreaPackages();
  }

  function openPackageDetail(sourceId) {
    const url = buildInaprocUrl(sourceId);
    if (!url) {
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

  function handlePackageRowKeydown(event, sourceId) {
    if (!event) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }

    event.preventDefault();
    openPackageDetail(sourceId);
  }

  function bindEvents() {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeRegionModal();
      }
    });

    dom.modal.addEventListener("click", (event) => {
      if (event.target === dom.modal) {
        closeRegionModal();
      }
    });
  }

  async function bootstrap() {
    renderBootstrapLoading();

    try {
      dashboardData = normalizeDashboardData(await fetchJson("/bootstrap"));
      regionsByKey = new Map(dashboardData.regions.map((region) => [region.regionKey, region]));
      provincesByKey = new Map(dashboardData.provinceView.provinces.map((province) => [province.provinceKey, province]));
      renderKpis();
      renderLegend();
      initMap();
      renderFilterChips();
      renderTabs();
      renderSidebarContent();
    } catch (error) {
      renderBootstrapError(formatFetchError(error));
    }
  }

  window.dashboardActions = {
    changeModalPage,
    closeRegionModal,
    handlePackageRowKeydown,
    openAreaModal,
    openOwnerModal,
    openPackageDetail,
    setMapFilter,
    setModalOwnerType,
    setModalPriorityOnly,
    setModalSearch,
    setModalSeverity,
    setSearch,
    setSort,
    setTab,
  };

  bindEvents();
  bootstrap();

  // --- FUNGSI MODAL PANDUAN DATA ---
  window.bukaPanduanData = function() {
    document.getElementById('modalPanduan').style.display = 'block';
  };

  window.tutupPanduanData = function() {
    document.getElementById('modalPanduan').style.display = 'none';
  };

  // --- FUNGSI PANEL INOVASI DAERAH ---

  window.bukaDeteksiAnomali = function() {
    // 1. Cari kunci wilayah (Region Key) untuk Kab. Bandung
    const areaKeys = Array.from(regionsByKey.keys());
    if (areaKeys.length > 0) {
        const bandungKey = areaKeys[0]; // Karena sudah difilter, pasti ini Kab. Bandung
        
        // 2. Buka pop-up tabel untuk Kab. Bandung
        openAreaModal(bandungKey);
        
        // 3. Otomatis ketik kata sandi "atk" (atau "makan") setelah pop-up terbuka
        setTimeout(() => {
            dashboardActions.setModalSearch("atk");
        }, 600); // Jeda 0.6 detik agar animasi pop-up selesai dulu
    }
  };

  // --- FUNGSI MODAL UMKM ---
 window.bukaRekomendasiUMKM = async function() {
    const trendContainer = document.getElementById('umkm-trend-container');
    const regionContainer = document.getElementById('umkm-region-container');
    
    // Detektor Kotak Hilang
    if (!trendContainer || !regionContainer) {
        console.error("Wadah HTML tidak ditemukan! Pastikan id di index.html sudah di-update.");
        return;
    }

    document.getElementById('modalUMKM').style.display = 'block';
    
    try {
        const response = await fetch('https://9g4qcr-3000.csb.app/api/stats/potensi-umkm');
        const data = await response.json(); 
        
        // --- 1. RENDER GRAFIK TREN ---
        const maxData = Math.max(...data.trendData.map(d => d.jumlah));
        trendContainer.innerHTML = data.trendData.map((item) => {
            const heightPercent = (item.jumlah / maxData) * 100;
            const isLastYear = item.tahun === 2025;
            const barColor = isLastYear ? " #d4af37" : "var(--sage)";

            return `
            <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%;">
                <span style="color: #f0d8a8; font-size: 10px; font-weight: bold; margin-bottom: 3px;">${item.jumlah}</span>
                <div style="width: 100%; background: ${barColor}; height: ${heightPercent}%; border-radius: 3px 3px 0 0; opacity: ${isLastYear ? '1' : '0.7'};"></div>
                <span style="color: var(--t1); font-size: 11px; margin-top: 5px;">${item.tahun}</span>
            </div>
            `;
        }).join('');

        // --- 2. RENDER KARTU WILAYAH DENGAN CONTOH ---
        regionContainer.innerHTML = data.regionData.map((umkm, index) => {
            const warnaGaris = index % 2 === 0 ? " #d4af37" : "var(--sage)";
            const warnaBg = index % 2 === 0 ? "rgba(181, 168, 130, 0.1)" : "rgba(123, 134, 163, 0.1)";

            return `
            <div style="background: ${warnaBg}; border-left: 3px solid ${warnaGaris}; padding: 12px; border-radius: 4px;">
                <strong style="color: #f0d8a8; display: block; margin-bottom: 5px; font-size: 12px;">📍 Kec. ${umkm.wilayah}</strong>
                <div style="color: var(--t1); font-size: 11px; margin-bottom: 8px;">Sektor: <strong style="color: white;">${umkm.sektor}</strong></div>
                
                <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; border: 1px dashed ${warnaGaris}50;">
                    <div style="color: var(--t3); font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px;">Rekomendasi Vendor:</div>
                    <div style="color: ${warnaGaris}; font-size: 11px; font-weight: bold;">🏢 ${umkm.contoh}</div>
                </div>
            </div>
            `;
        }).join('');

    } catch (error) {
        console.error(error);
        trendContainer.innerHTML = '<p style="color: var(--brick);">Gagal menarik data UMKM.</p>';
        regionContainer.innerHTML = '';
    }
  };
  window.tutupModalUMKM = function() {
    document.getElementById('modalUMKM').style.display = 'none';
  };

  window.bukaGrafikAnggaran = async function() {
    const container = document.getElementById('opd-chart-container');
    document.getElementById('modalGrafikOPD').style.display = 'block';
    
    try {
        const response = await fetch('https://9g4qcr-3000.csb.app/api/stats/opd-breakdown'); 
        const data = await response.json();
        
        if (!data || data.length === 0) {
            container.innerHTML = '<p style="text-align: center;">Data tidak ditemukan.</p>';
            return;
        }

        const maxBudget = data[0].total_budget;

        container.innerHTML = data.map((opd, index) => {
            const percentage = ((opd.total_budget / maxBudget) * 100).toFixed(0);
            const formattedBudget = new Intl.NumberFormat('id-ID', {
                style: 'currency',
                currency: 'IDR',
                maximumFractionDigits: 0
            }).format(opd.total_budget);

            // Warna warni Nemesis untuk 5 ranking teratas
            const barColor = index === 0 ? "var(--brick)" : index === 1 ? "var(--sage)" : index === 2 ? " #d4af37" : index === 3 ? "var(--rose)" : "var(--t2)";

            return `
                <div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <strong style="color: #cdd4e6; font-size: 13px; letter-spacing: 0.5px;">${index + 1}. ${opd.name}</strong>
                        <span style="color: ${barColor}; font-family: monospace; font-weight: bold; font-size: 14px;">${formattedBudget}</span>
                    </div>
                    <div style="width: 100%; background: rgba(0,0,0,0.3); border-radius: 6px; height: 14px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div style="width: ${percentage}%; background: ${barColor}; height: 100%; border-radius: 6px; box-shadow: 0 0 10px ${barColor}40;"></div>
                    </div>
                </div>
            `;
        }).join('');

    } catch (error) {
        console.error("Gagal mengambil data OPD:", error);
        container.innerHTML = '<p style="text-align: center; color: var(--brick);">Gagal memuat data dari database.</p>';
    }
  };

  window.tutupGrafikAnggaran = function() {
    document.getElementById('modalGrafikOPD').style.display = 'none';
  };

  window.bukaRoroJonggrang = function() {
    const areaKeys = Array.from(regionsByKey.keys());
    if (areaKeys.length > 0) {
        const bandungKey = areaKeys[0];
        
        // Buka pop-up tabel untuk Kab. Bandung
        openAreaModal(bandungKey);
        
        // Pancing dengan kata kunci "pembangunan" agar proyek fisik miliaran langsung muncul
        setTimeout(() => {
            dashboardActions.setModalSearch("pembangunan");
        }, 600); 
    }
  };

  window.bukaPerjalananDinas = function() {
    const areaKeys = Array.from(regionsByKey.keys());
    if (areaKeys.length > 0) {
        const bandungKey = areaKeys[0];
        
        // Buka pop-up tabel untuk Kab. Bandung
        openAreaModal(bandungKey);
        
        // Pancing dengan kata kunci "perjalanan dinas"
        setTimeout(() => {
            dashboardActions.setModalSearch("perjalanan dinas");
        }, 600); 
    }
  };
  
})();
