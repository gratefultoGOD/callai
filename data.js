// ─── Demo Properties + Reservations (SQLite-backed) ───────────────────
// Properties are static demo data (unchanged).
// Reservations are now persisted in SQLite via db.js.

const crypto = require("crypto");
const { stmts } = require("./db");

// ─── Static Demo Properties ────────────────────────────────────────────
const properties = [
    {
        id: "P001",
        title: "Skyline Penthouse with City Views",
        location: "Manhattan, New York",
        type: "sale",
        price: 4850000,
        rooms: "5+2",
        area: 3400,
        floor: "25th Floor",
        features: ["City views", "Private elevator", "Smart home system", "Covered parking", "Rooftop pool"],
        available: true,
        description: "Luxurious penthouse in Manhattan's most prestigious residential tower with breathtaking skyline views."
    },
    {
        id: "P002",
        title: "Modern Villa with Garden",
        location: "Beverly Hills, Los Angeles",
        type: "sale",
        price: 6750000,
        rooms: "6+2",
        area: 4800,
        floor: "Detached",
        features: ["10,000 sq ft garden", "Private pool", "Fireplace", "3-car garage", "24/7 security"],
        available: true,
        description: "Stunning detached villa in the tranquil Beverly Hills neighborhood with expansive gardens."
    },
    {
        id: "P003",
        title: "Waterfront Apartment",
        location: "Miami Beach, Florida",
        type: "sale",
        price: 2200000,
        rooms: "3+1",
        area: 1650,
        floor: "12th Floor",
        features: ["Ocean views", "Near metro", "Covered parking", "Fitness center"],
        available: true,
        description: "Modern beachfront apartment in Miami Beach with stunning ocean panoramas."
    },
    {
        id: "P004",
        title: "Luxury Residence Suite",
        location: "Downtown, Chicago",
        type: "rent",
        price: 8500,
        rooms: "2+1",
        area: 1300,
        floor: "18th Floor",
        features: ["Fully furnished", "Concierge", "Pool", "Gym", "24/7 security"],
        available: true,
        description: "Fully equipped luxury residence suite in Chicago's premier business district."
    },
    {
        id: "P005",
        title: "Historic Brownstone Home",
        location: "Georgetown, Washington D.C.",
        type: "sale",
        price: 3400000,
        rooms: "4+1",
        area: 2200,
        floor: "3 Stories",
        features: ["Historic charm", "Fully restored", "Rooftop terrace", "River views"],
        available: true,
        description: "Beautifully restored historic brownstone in Georgetown with original architectural details."
    },
    {
        id: "P006",
        title: "Modern Studio Apartment",
        location: "SoMa, San Francisco",
        type: "rent",
        price: 4200,
        rooms: "1+1",
        area: 700,
        floor: "8th Floor",
        features: ["Fully furnished", "Near transit", "Parking", "Gym"],
        available: true,
        description: "Sleek and modern studio apartment near San Francisco's tech hub."
    }
];

// ─── Reservations (SQLite-backed) ──────────────────────────────────────
function generateReservationId() {
    // Short human-readable ID: R + 6 hex chars
    return "R" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function addReservation(reservation) {
    const entry = {
        id: generateReservationId(),
        type: reservation.type,
        property_id: reservation.property_id,
        property_title: reservation.property_title,
        customer_name: reservation.customer_name,
        customer_phone: reservation.customer_phone,
        date: reservation.date || null,
        time: reservation.time || null,
        notes: reservation.notes || "",
        created_at: new Date().toISOString(),
    };

    stmts.reservationInsert.run(entry);
    console.log(`📝 New reservation: ${entry.id} — ${entry.property_title} for ${entry.customer_name}`);

    // Return in the same shape the server expects
    return {
        id: entry.id,
        type: entry.type,
        property_id: entry.property_id,
        property_title: entry.property_title,
        customer_name: entry.customer_name,
        customer_phone: entry.customer_phone,
        date: entry.date,
        time: entry.time,
        notes: entry.notes,
        created_at: entry.created_at,
    };
}

function getReservations() {
    return stmts.reservationAll.all().map(row => ({
        id: row.id,
        type: row.type,
        property_id: row.property_id,
        property_title: row.property_title,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone,
        date: row.date,
        time: row.time,
        notes: row.notes,
        created_at: row.created_at,
    }));
}

function getProperties() {
    return properties;
}

function searchProperties({ location, min_price, max_price, rooms, type }) {
    let results = [...properties];
    if (location) results = results.filter(p => p.location.toLowerCase().includes(location.toLowerCase()));
    if (type) results = results.filter(p => p.type === type);
    if (rooms) results = results.filter(p => p.rooms.includes(rooms));
    if (min_price) results = results.filter(p => p.price >= min_price);
    if (max_price) results = results.filter(p => p.price <= max_price);
    return results;
}

function getPropertyById(id) {
    return properties.find(p => p.id === id) || null;
}

module.exports = {
    properties,
    addReservation,
    getReservations,
    getProperties,
    searchProperties,
    getPropertyById,
};
