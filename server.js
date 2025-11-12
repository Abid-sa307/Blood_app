// server.js — Syed Samaj Palanpur Blood Group Data (PostgreSQL)

require('dotenv').config();
const express = require("express");
const { Pool } = require('pg');
const path = require("path");

// Optional Excel export (fallback to CSV if not installed)
let ExcelJS = null;
try { ExcelJS = require("exceljs"); } catch {}

const app = express();

// ── Config ──────────────────────────────────────────────────────────────────────
const APP_NAME = "Syed Samaj Palanpur Blood Group Data";
const BLOOD_GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const DONATION_COOLDOWN_DAYS = parseInt(process.env.DONATION_COOLDOWN_DAYS || "90", 10);

// Database configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test the connection and initialize the database
async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('Successfully connected to PostgreSQL database');
    await ensureSchema(client);
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  } finally {
    client.release();
  }
  return pool;
}

// ── Middleware ──────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ─────────────────────────────────────────────────────────────────────
function isValidContact(v) {
  const digits = (v || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}
function isValidBlood(b) { return BLOOD_GROUPS.includes(b); }
function parseDateISO(d) {
  if (!d) return null;
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function toISODateString(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function daysBetweenISO(iso) {
  if (!iso) return Infinity;
  const [y,m,d] = iso.split("-").map(Number);
  const a = new Date(y, m - 1, d);
  const b = new Date();
  a.setHours(0,0,0,0); b.setHours(0,0,0,0);
  return Math.floor((b - a) / 86400000);
}
function computeAvailability(lastDonationISO) {
  const days = daysBetweenISO(lastDonationISO);
  return lastDonationISO ? (days >= DONATION_COOLDOWN_DAYS ? 1 : 0) : 1;
}
function nextEligibleDate(lastDonationISO) {
  const iso = toISODateString(lastDonationISO);
  if (!iso) return null;
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + DONATION_COOLDOWN_DAYS);
  return toISODateString(dt);
}

// Allowed date window = [today - 2 years, today]
function getAllowedDonationWindow() {
  const today = new Date(); today.setHours(0,0,0,0);
  const maxISO = toISODateString(today);
  const minD = new Date(today); minD.setFullYear(minD.getFullYear() - 2);
  const minISO = toISODateString(minD);
  return { minISO, maxISO };
}
function isWithinAllowedWindow(iso) {
  if (!iso) return false;
  const { minISO, maxISO } = getAllowedDonationWindow();
  return iso >= minISO && iso <= maxISO;
}
function parseAvailableFlag(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).toLowerCase();
  if (["1","true","yes","y","available"].includes(s)) return 1;
  if (["0","false","no","n","unavailable"].includes(s)) return 0;
  return null;
}

// ── DB init & schema ────────────────────────────────────────────────────────────
async function ensureSchema(client) {
  try {
    // Create tables if they don't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        contact VARCHAR(32) NOT NULL UNIQUE,
        blood_group VARCHAR(3) NOT NULL 
          CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
        last_donation_date DATE,
        available BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes if they don't exist
    await client.query('CREATE INDEX IF NOT EXISTS idx_bg ON users(blood_group)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_available ON users(available)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_created ON users(created_at)');

    console.log('Database schema is ready');
  } catch (error) {
    console.error('Error setting up database schema:', error);
    throw error;
  }

}

// ── Routes ──────────────────────────────────────────────────────────────────────

// Create user (all fields required)
app.post("/api/users", async (req, res) => {
  try {
    const { name, contactNumber, bloodGroup, lastDonationDate, available, eligible } = req.body;

    if (!name || name.trim().length < 2)
      return res.status(400).json({ ok: false, error: "Name is required (min 2 chars)." });
    if (!contactNumber || !isValidContact(contactNumber))
      return res.status(400).json({ ok: false, error: "Valid contact number is required." });
    if (!isValidBlood(bloodGroup))
      return res.status(400).json({ ok: false, error: "Blood group is required." });
    if (!lastDonationDate)
      return res.status(400).json({ ok: false, error: "Last donation date is required." });

    const lastISO = parseDateISO(lastDonationDate);
    if (!lastISO)
      return res.status(400).json({ ok: false, error: "Last donation must be YYYY-MM-DD." });
    if (!isWithinAllowedWindow(lastISO)) {
      const { minISO, maxISO } = getAllowedDonationWindow();
      return res.status(400).json({ ok: false, error: `Last donation must be between ${minISO} and ${maxISO}.` });
    }

    const manualAvail = parseAvailableFlag(available ?? eligible);
    if (manualAvail === null)
      return res.status(400).json({ ok: false, error: "Eligible to donate (Yes/No) is required." });

    const finalAvail = manualAvail ?? computeAvailability(lastISO);

    const [result] = await pool.execute(
      "INSERT INTO users (name, contact, blood_group, last_donation_date, available) VALUES (?, ?, ?, ?, ?)",
      [name.trim(), String(contactNumber).trim(), bloodGroup, lastISO, finalAvail]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update user (all fields required when saving)
app.put("/api/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });

    const { name, contactNumber, bloodGroup, lastDonationDate, available, eligible } = req.body;

    const [[existing]] = await pool.query("SELECT * FROM users WHERE id=?", [id]);
    if (!existing) return res.status(404).json({ ok: false, error: "User not found" });

    const newName = (typeof name === "string" && name.trim().length >= 2) ? name.trim() : null;
    const newContact = (typeof contactNumber === "string" && isValidContact(contactNumber)) ? contactNumber.trim() : null;
    const newBG = isValidBlood(bloodGroup) ? bloodGroup : null;
    if (!newName) return res.status(400).json({ ok: false, error: "Name is required." });
    if (!newContact) return res.status(400).json({ ok: false, error: "Valid contact is required." });
    if (!newBG) return res.status(400).json({ ok: false, error: "Blood group is required." });

    let newLastISO = parseDateISO(lastDonationDate);
    if (!newLastISO) return res.status(400).json({ ok: false, error: "Last donation date is required (YYYY-MM-DD)." });
    if (!isWithinAllowedWindow(newLastISO)) {
      const { minISO, maxISO } = getAllowedDonationWindow();
      return res.status(400).json({ ok: false, error: `Last donation must be between ${minISO} and ${maxISO}.` });
    }

    const manualAvail = parseAvailableFlag(available ?? eligible);
    if (manualAvail === null)
      return res.status(400).json({ ok: false, error: "Eligible to donate (Yes/No) is required." });

    const newAvailable = manualAvail ?? computeAvailability(newLastISO);

    await pool.execute(
      "UPDATE users SET name=?, contact=?, blood_group=?, last_donation_date=?, available=? WHERE id=?",
      [newName, newContact, newBG, newLastISO, newAvailable, id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// List / Report
app.get("/api/users", async (req, res) => {
  try {
    const { bloodGroup, availability, limit } = req.query;

    if (bloodGroup && !isValidBlood(bloodGroup)) {
      return res.status(400).json({ ok: false, error: "Invalid blood group" });
    }
    let avail = undefined;
    if (availability !== undefined && availability !== "") {
      const m = String(availability).toLowerCase();
      if (["1","0","true","false","available","unavailable"].includes(m)) {
        avail = (m === "1" || m === "true" || m === "available") ? 1 : 0;
      } else return res.status(400).json({ ok: false, error: "Invalid availability filter" });
    }
    const lim = Math.max(1, Math.min(200, Number(limit) || 100));

    const where = [];
    const params = [];
    if (bloodGroup) { where.push("blood_group=?"); params.push(bloodGroup); }
    if (avail !== undefined) { where.push("available=?"); params.push(avail); }

    const sql = `
      SELECT id, name, contact, blood_group, last_donation_date, available, created_at
      FROM users
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT ${lim}
    `;
    const [rows] = await pool.query(sql, params);

    const data = rows.map(r => {
      const lastISO = toISODateString(r.last_donation_date);
      return { ...r, last_donation_date: lastISO, next_eligible_date: nextEligibleDate(lastISO) };
    });

    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Dashboard
app.get("/api/dashboard", async (_req, res) => {
  try {
    const [[{ c: total }]] = await pool.query("SELECT COUNT(*) AS c FROM users");
    const [[{ c: availableCount }]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE available=1");
    const unavailableCount = Number(total) - Number(availableCount);

    const [byGroupRows] = await pool.query("SELECT blood_group, COUNT(*) AS c FROM users GROUP BY blood_group");
    const [availByGroupRows] = await pool.query("SELECT blood_group, COUNT(*) AS c FROM users WHERE available=1 GROUP BY blood_group");

    const byGroup = Object.fromEntries(BLOOD_GROUPS.map(g => [g, 0]));
    const availableByGroup = Object.fromEntries(BLOOD_GROUPS.map(g => [g, 0]));
    for (const r of byGroupRows) byGroup[r.blood_group] = Number(r.c) || 0;
    for (const r of availByGroupRows) availableByGroup[r.blood_group] = Number(r.c) || 0;

    res.json({
      ok: true,
      totalUsers: Number(total) || 0,
      availableUsers: Number(availableCount) || 0,
      unavailableUsers: Number(unavailableCount) || 0,
      byGroup,
      availableByGroup,
      groups: BLOOD_GROUPS,
      cooldownDays: DONATION_COOLDOWN_DAYS,
      appName: APP_NAME,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Export (xlsx if exceljs, else csv) — uses "Not available"
app.get("/api/export/users", async (req, res) => {
  try {
    const { bloodGroup, availability } = req.query;
    const where = []; const params = [];
    if (bloodGroup) {
      if (!BLOOD_GROUPS.includes(bloodGroup)) return res.status(400).json({ ok: false, error: "Invalid blood group" });
      where.push("blood_group=?"); params.push(bloodGroup);
    }
    if (availability !== undefined && availability !== "") {
      const m = String(availability).toLowerCase();
      if (!["1","0","true","false","available","unavailable"].includes(m)) return res.status(400).json({ ok: false, error: "Invalid availability filter" });
      const avail = (m === "1" || m === "true" || m === "available") ? 1 : 0;
      where.push("available=?"); params.push(avail);
    }
    const sql = `
      SELECT id, name, contact, blood_group, last_donation_date, available, created_at
      FROM users
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
    `;
    const [rows] = await pool.query(sql, params);

    const totals = Object.fromEntries(BLOOD_GROUPS.map(g => [g, { total: 0, available: 0 }]));
    for (const r of rows) { if (totals[r.blood_group]) { totals[r.blood_group].total++; if (r.available) totals[r.blood_group].available++; } }

    if (ExcelJS) {
      const wb = new ExcelJS.Workbook();
      wb.creator = APP_NAME; wb.created = new Date();
      const ws = wb.addWorksheet("Users");
      ws.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "Name", key: "name", width: 24 },
        { header: "Contact", key: "contact", width: 20 },
        { header: "Blood Group", key: "blood_group", width: 12 },
        { header: "Last Donation", key: "last_donation_date", width: 15 },
        { header: "Next Eligible", key: "next_eligible_date", width: 15 },
        { header: "Availability", key: "available", width: 14 },
        { header: "Created At", key: "created_at", width: 22 },
      ];
      rows.forEach(r => {
        const lastISO = toISODateString(r.last_donation_date);
        ws.addRow({
          id: r.id, name: r.name, contact: r.contact, blood_group: r.blood_group,
          last_donation_date: lastISO || "", next_eligible_date: nextEligibleDate(lastISO) || "",
          available: r.available ? "Available" : "Not available",
          created_at: toISODateString(r.created_at) || ""
        });
      });
      const ws2 = wb.addWorksheet("Summary");
      ws2.columns = [
        { header: "Blood Group", key: "bg", width: 12 },
        { header: "Total Users", key: "total", width: 14 },
        { header: "Available", key: "avail", width: 12 },
        { header: "Not available", key: "unavail", width: 16 },
      ];
      BLOOD_GROUPS.forEach(g => {
        const t = totals[g];
        ws2.addRow({ bg: g, total: t.total, avail: t.available, unavail: t.total - t.available });
      });
      res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="syed_samaj_palanpur_blood_group_data_${Date.now()}.xlsx"`);
      await wb.xlsx.write(res); return res.end();
    }

    // CSV fallback
    const esc = v => v == null ? "" : String(v).replace(/"/g, '""');
    let csv = 'ID,Name,Contact,Blood Group,Last Donation,Next Eligible,Availability,Created At\r\n';
    for (const r of rows) {
      const lastISO = toISODateString(r.last_donation_date);
      csv += `"${esc(r.id)}","${esc(r.name)}","${esc(r.contact)}","${esc(r.blood_group)}","${esc(lastISO)}","${esc(nextEligibleDate(lastISO)||"")}","${r.available ? "Available" : "Not available"}","${esc(toISODateString(r.created_at)||"")}"\r\n`;
    }
    csv += '\r\nSummary\r\nBlood Group,Total Users,Available,Not available\r\n';
    BLOOD_GROUPS.forEach(g => { const t = totals[g]; csv += `"${g}",${t.total},${t.available},${t.total - t.available}\r\n`; });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="syed_samaj_palanpur_blood_group_data_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Export failed" });
  }
});

// Health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ── Start server ────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    // Initialize database
    await initDatabase();
    
    // Start the server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`${APP_NAME} running on port ${PORT}`);
      console.log(`Connected to PostgreSQL database`);
      console.log(`Donation cooldown = ${DONATION_COOLDOWN_DAYS} days`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application
startServer();

process.on("SIGINT", async () => { try { if (pool) await pool.end(); } catch {} process.exit(0); });