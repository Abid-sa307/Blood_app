// server.js — Syed Samaj Palanpur Blood Group Data (MySQL)

require('dotenv').config();
const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");

// Optional Excel export (fallback to CSV if not installed)
let ExcelJS = null;
try { ExcelJS = require("exceljs"); } catch {}

const app = express();

// ── Config ──────────────────────────────────────────────────────────────────────
const APP_NAME = "Syed Samaj Palanpur Blood Group Data";
const BLOOD_GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const DONATION_COOLDOWN_DAYS = parseInt(process.env.DONATION_COOLDOWN_DAYS || "90", 10);
const PORT_BASE = process.env.PORT || 3000;

const MYSQL_HOST = process.env.MYSQL_HOST || "localhost";
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DB = process.env.MYSQL_DB || "blood_app";

let pool;

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
async function ensureSchema() {
  const dbConfig = {
    host: process.env.MYSQL_HOST || MYSQL_HOST,
    port: process.env.MYSQL_PORT || MYSQL_PORT,
    user: process.env.MYSQL_USER || MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || MYSQL_PASSWORD,
    database: process.env.MYSQL_DB || MYSQL_DB,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true
  };

  try {
    // First, try to connect to the database directly
    pool = mysql.createPool(dbConfig);
    
    // Test the connection
    await pool.query('SELECT 1');
    console.log('Connected to existing database');
  } catch (error) {
    console.log('Creating database and tables...');
    // If connection fails, try to create the database
    try {
      const tempConfig = { ...dbConfig };
      delete tempConfig.database; // Remove database name to connect to server
      
      const serverConn = await mysql.createConnection(tempConfig);
      await serverConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` DEFAULT CHARACTER SET utf8mb4`);
      await serverConn.end();

      // Now create the pool with the database
      pool = mysql.createPool(dbConfig);
    } catch (createError) {
      console.error('Failed to create database:', createError);
      throw createError;
    }
  }

  // Create tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(128) NOT NULL,
      contact VARCHAR(32) NOT NULL,
      blood_group ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
      last_donation_date DATE NULL,
      available TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_bg (blood_group),
      INDEX idx_available (available),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try { await pool.query("ALTER TABLE users ADD COLUMN last_donation_date DATE NULL AFTER blood_group"); }
  catch (e) { if (!e || e.code !== "ER_DUP_FIELDNAME") throw e; }
  try { await pool.query("ALTER TABLE users ADD COLUMN available TINYINT(1) NOT NULL DEFAULT 1 AFTER last_donation_date"); }
  catch (e) { if (!e || e.code !== "ER_DUP_FIELDNAME") throw e; }
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

// ── Start (port fallback) ───────────────────────────────────────────────────────
function listenWithFallback(app, startPort = 3000, maxAttempts = 10) {
  return new Promise((resolve, reject) => {
    let port = startPort, attempts = 0;
    const tryListen = () => {
      const server = app.listen(port, () => resolve({ server, port }));
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && attempts < maxAttempts) { attempts++; port++; tryListen(); }
        else reject(err);
      });
    };
    tryListen();
  });
}

ensureSchema()
  .then(async () => {
    const { port } = await listenWithFallback(app, PORT_BASE);
    console.log(`Server running at http://localhost:${port}`);
    console.log(`MySQL → ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);
    console.log(`Donation cooldown = ${DONATION_COOLDOWN_DAYS} days`);
  })
  .catch((err) => { console.error("MySQL init failed:", err); process.exit(1); });

process.on("SIGINT", async () => { try { if (pool) await pool.end(); } catch {} process.exit(0); });