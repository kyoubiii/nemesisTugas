const express = require("express");
const cors = require("cors");
const { CORS_ORIGIN } = require("./config");
const { getBootstrapPayload, getOwnerPackages, getRegionPackages, getProvincePackages, getOPDBudgetBreakdown } = require("./dashboard-repository");

function resolveCorsOrigin() {
  if (CORS_ORIGIN === "*") {
    return "*";
  }

  return CORS_ORIGIN.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createApp(db) {
  const app = express();

  app.use(
    cors({
      origin: resolveCorsOrigin(),
    })
  );
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json(getBootstrapPayload(db));
  });

  app.get("/api/regions/:regionKey/packages", (req, res) => {
    const payload = getRegionPackages(db, req.params.regionKey, req.query);

    if (!payload) {
      res.status(404).json({ error: "Region not found" });
      return;
    }

    res.json(payload);
  });

  app.get("/api/provinces/:provinceKey/packages", (req, res) => {
    const payload = getProvincePackages(db, req.params.provinceKey, req.query);

    if (!payload) {
      res.status(404).json({ error: "Province not found" });
      return;
    }

    res.json(payload);
  });

// 👇 RUTE BARU UNTUK GRAFIK OPD 👇
  app.get('/api/stats/opd-breakdown', (req, res) => {
    try {
      // Panggil langsung fungsinya karena sudah di-import di atas
      const data = getOPDBudgetBreakdown(db);
      res.json(data);
    } catch (error) {
      console.error("Gagal mengambil data statistik OPD:", error);
      res.status(500).json({ error: "Gagal memuat data" });
    }
  });
  // 👆 AKHIR RUTE BARU 👆

  // 👇 RUTE INTEGRASI UMKM (VERSI CONTOH NYATA) 👇
  app.get('/api/stats/potensi-umkm', (req, res) => {
    try {
      const payload = {
        trendData: [
          { tahun: 2019, jumlah: 401 },
          { tahun: 2020, jumlah: 582 },
          { tahun: 2021, jumlah: 361 },
          { tahun: 2022, jumlah: 1171 },
          { tahun: 2023, jumlah: 2330 },
          { tahun: 2024, jumlah: 2922 },
          { tahun: 2025, jumlah: 1999 }
        ],
        regionData: [
          { 
            wilayah: "Soreang & Katapang", 
            sektor: "Konveksi & Seragam", 
            contoh: "Kawal Jahit Soreang" 
          },
          { 
            wilayah: "Majalaya & Paseh", 
            sektor: "Tekstil & Sarung", 
            contoh: "PT. Sandang Majalaya Textile (Samatex)" 
          },
          { 
            wilayah: "Baleendah (Jelekong)", 
            sektor: "Seni Wayang & Lukis", 
            contoh: "Girilaya Wayang Golek Galeri" 
          },
          { 
            wilayah: "Ciwidey & Pasirjambu", 
            sektor: "Olahan Makanan & Agribisnis", 
            contoh: "Pandawa Pusat Oleh-oleh Ciwidey" 
          }
        ]
      };
      
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: "Gagal memuat data" });
    }
  });

  app.get("/api/owners/packages", (req, res) => {
    const ownerType = (req.query.ownerType || "").trim();
    const ownerName = (req.query.ownerName || "").trim();

    if (!ownerType || !ownerName) {
      res.status(400).json({ error: "ownerType and ownerName are required" });
      return;
    }

    const payload = getOwnerPackages(db, req.query);

    if (!payload) {
      res.status(404).json({ error: "Owner not found" });
      return;
    }

    res.json(payload);
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = {
  createApp,
};
