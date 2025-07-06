// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Pool
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
});

app.use(express.json());

// 🔹 API: Ένταση Ενέργειας (για διαγράμματα)
app.get('/api/energy/intensity/:category', async (req, res) => {
  const category = req.params.category;
  const allowedCategories = ['total', 'coal', 'gas', 'nuclear', 'oil', 'renewables', 'netexport'];
  if (!allowedCategories.includes(category)) {
    return res.status(400).json({ error: 'Μη έγκυρη κατηγορία' });
  }

  try {
    const query = `
      SELECT country, year, ${category}
      FROM energy_intensity
      WHERE ${category} IS NOT NULL
      ORDER BY year, country;
    `;
    const { rows } = await pool.query(query);

    const dataMap = {};
    const yearSet = new Set();

    for (const row of rows) {
      const { country, year } = row;
      const value = parseFloat(row[category]);
      if (!dataMap[country]) dataMap[country] = {};
      dataMap[country][year] = value;
      yearSet.add(year);
    }

    const labels = Array.from(yearSet).sort();
    const datasets = Object.entries(dataMap).map(([country, yearValues]) => ({
      label: country,
      data: labels.map(year => yearValues[year] ?? null)
    }));

    res.json({ labels, datasets });
  } catch (err) {
    console.error('Σφάλμα API έντασης:', err);
    res.status(500).json({ error: 'Σφάλμα εξυπηρετητή' });
  }
});

// 🔹 API: GeoJSON για θεματικό χάρτη έντασης
app.get('/api/energy/intensity-map/:year', async (req, res) => {
  const year = parseInt(req.params.year);
  const allowed = ['total', 'coal', 'gas', 'nuclear', 'oil', 'renewables', 'netexport'];
  const category = allowed.includes(req.query.category) ? req.query.category : 'total';

  try {
    const result = await pool.query(`
      SELECT 
        c.country,
        e.${category} AS intensity,
        ST_AsGeoJSON(c.geom)::json AS geometry
      FROM countries c
      JOIN energy_intensity e 
        ON c.country = e.country
      WHERE e.year = $1
        AND e.${category} IS NOT NULL
    `, [year]);

    const geojson = {
      type: "FeatureCollection",
      features: result.rows.map(row => ({
        type: "Feature",
        geometry: row.geometry,
        properties: {
          country: row.country,
          intensity: row.intensity
        }
      }))
    };

    res.json(geojson);
  } catch (err) {
    console.error("Σφάλμα intensity map:", err);
    res.status(500).json({ error: "Σφάλμα εξυπηρετητή" });
  }
});

// 🔹 API: Θεματικός Χάρτης Συγκριτικού Δείκτη
app.get('/api/energy/comparative-index-map/:year', async (req, res) => {
  const year = req.params.year;
  const column = `i${year}`;

  try {
    const result = await pool.query(`
      SELECT
        c.country,
        ST_AsGeoJSON(c.geom)::json AS geometry,
        e."${column}" AS intensity
      FROM countries c
      JOIN energy_index_by_country e ON c.country = e.code
      WHERE e."${column}" IS NOT NULL
    `);

    const geojson = {
      type: "FeatureCollection",
      features: result.rows.map(row => ({
        type: "Feature",
        properties: {
          country: row.country,
          intensity: parseFloat(row.intensity)
        },
        geometry: row.geometry
      }))
    };

    res.json(geojson);
  } catch (err) {
    console.error("Σφάλμα comparative index:", err);
    res.status(500).send("Error loading comparative index data");
  }
});

// 🔹 API: Έτη
app.get('/api/energy/years', async (_req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT year FROM energy_summary ORDER BY year`);
    res.json(result.rows.map(r => r.year));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Σφάλμα στη βάση' });
  }
});

// 🔹 API: Τριγωνικό διάγραμμα
app.get('/api/energy/ternary', async (req, res) => {
  const year = req.query.year;
  const sizeBy = req.query.sizeBy === 'population' ? 'population' : 'total_energy';

  try {
    const result = await pool.query(`
      SELECT
        country,
        coal_percent AS a,
        gas_percent AS b,
        renewables_percent AS c,
        ${sizeBy} AS size
      FROM energy_summary
      WHERE year = $1
        AND coal_percent IS NOT NULL
        AND gas_percent IS NOT NULL
        AND renewables_percent IS NOT NULL
    `, [year]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Σφάλμα στη βάση' });
  }
});

// 🔹 API: Παραγωγή Ενέργειας
app.get('/api/energy/production/:year', async (req, res) => {
  const year = parseInt(req.params.year);

  try {
    const result = await pool.query(`
      SELECT country, ep1, ep2, ep3, ep4, ep5, ep6, ep7, ep8, ep9
      FROM energy_production
      WHERE year = $1
      ORDER BY country;
    `, [year]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Δεν βρέθηκαν δεδομένα για το έτος' });
    }

    const labels = result.rows.map(row => row.country);
    const datasets = [];

    const epLabels = [
      "Coal, Peat and Manufactured Gases",
      "Total Combustible Fuels",
      "Hydro",
      "Natural Gas",
      "Nuclear",
      "Oil and Petroleum Products",
      "Total Renewables (Geo, Solar, Wind, Other)",
      "Combustible Renewables",
      "Other Combustible Non-Renewables"
    ];

    const colors = [
      'rgb(54, 162, 235)', 'rgb(255, 99, 132)', 'rgb(255, 206, 86)',
      'rgb(75, 192, 192)', 'rgb(153, 102, 255)', 'rgb(255, 159, 64)',
      'rgb(0, 128, 0)', 'rgb(200, 200, 0)', 'rgb(128, 64, 0)'
    ];

    for (let i = 1; i <= 9; i++) {
      datasets.push({
        label: epLabels[i - 1],
        data: result.rows.map(row => parseFloat(row[`ep${i}`])),
        backgroundColor: colors[i - 1],
        stack: 'energy'
      });
    }

    res.json({ labels, datasets });
  } catch (err) {
    console.error("Σφάλμα παραγωγής:", err);
    res.status(500).json({ error: 'Σφάλμα εξυπηρετητή' });
  }
});

// 🔹 API: Κατανάλωση Ενέργειας
app.get('/api/energy/consumption/:year', async (req, res) => {
  const year = parseInt(req.params.year);

  try {
    const result = await pool.query(`
      SELECT country, industry, residential, transport
      FROM energy_consumption
      WHERE year = $1
      ORDER BY country;
    `, [year]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Δεν βρέθηκαν δεδομένα για το έτος' });
    }

    const labels = result.rows.map(row => row.country);
    const datasets = [
      {
        label: "Industry",
        data: result.rows.map(row => parseFloat(row.industry)),
        backgroundColor: "blue",
        stack: "energy"
      },
      {
        label: "Residential",
        data: result.rows.map(row => parseFloat(row.residential)),
        backgroundColor: "orange",
        stack: "energy"
      },
      {
        label: "Transport",
        data: result.rows.map(row => parseFloat(row.transport)),
        backgroundColor: "gray",
        stack: "energy"
      }
    ];

    res.json({ labels, datasets });
  } catch (err) {
    console.error("Σφάλμα κατανάλωσης:", err);
    res.status(500).json({ error: "Σφάλμα εξυπηρετητή" });
  }
});

// 🔹 API: Έτη κατανάλωσης
app.get('/api/energy/consumption-years', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT year FROM energy_consumption ORDER BY year;
    `);
    res.json(result.rows.map(r => r.year));
  } catch (err) {
    console.error("Σφάλμα ανάκτησης ετών:", err);
    res.status(500).json({ error: 'Σφάλμα στη βάση' });
  }
});

// 🔹 API: Λίστα χωρών
app.get('/api/countries', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT country FROM energy_intensity ORDER BY country;
    `);
    res.json(result.rows.map(r => r.country));
  } catch (err) {
    console.error("Σφάλμα ανάκτησης χωρών:", err);
    res.status(500).json({ error: 'Σφάλμα στη βάση' });
  }
});

// ✅ Static files
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
