// MeluFrontend - copia/backend/db.js

import { createClient } from "@libsql/client";
import 'dotenv/config';
import bcrypt from 'bcryptjs';

// 🔑 Configuración del Cliente Turso/LibSQL
export const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// 🟢 FUNCIÓN DE AYUDA: Generador simple de código alfanumérico
function generateRandomCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Inicializa la base de datos: crea tablas si no existen y aplica migraciones
 * (Se mantiene IF NOT EXISTS para robustez y evitar errores al re-ejecutar)
 */
export async function initializeDb() {
    try {
        // 1. Tabla USERS (Esquema completo con todos los campos)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT,
                password_hash TEXT NOT NULL,
                plain_password TEXT,
                referral_code TEXT,
                role TEXT DEFAULT 'Usuario' NOT NULL,
                transactions_history TEXT DEFAULT '[]',
                balance REAL DEFAULT 0.00,
                discount_percentage INTEGER DEFAULT 0,
                is_banned INTEGER DEFAULT 0,
                is_approved INTEGER DEFAULT 1,
                referred_by_user_id INTEGER DEFAULT NULL,
                premium_expires_at DATETIME DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'users' table ready.");

        // 🟢 MIGRACIÓN: Verificar y agregar 'plain_password' si falta (para compatibilidad)
        try {
             await client.execute("SELECT plain_password FROM users LIMIT 1");
        } catch (e) {
            console.log("🟡 Migrating: Adding 'plain_password' column to users table...");
            await client.execute("ALTER TABLE users ADD COLUMN plain_password TEXT");
            console.log("✅ Migration successful: 'plain_password' column added.");
        }
        
        // 2. Tabla PRODUCTS (Esquema completo usado en server.js)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                platform TEXT,
                description TEXT,
                product_details TEXT,
                instructions TEXT,
                is_renewable INTEGER DEFAULT 0,
                delivery TEXT,
                duration TEXT,
                type TEXT,
                price_standard REAL DEFAULT 0.00,
                price_premium REAL DEFAULT 0.00,
                price_renewal_standard REAL DEFAULT 0.00,
                price_renewal_premium REAL DEFAULT 0.00,
                image_url TEXT,
                images TEXT,
                stock INTEGER DEFAULT 0,
                provider TEXT,
                icon_name TEXT,
                creator_user_id INTEGER,
                is_published INTEGER DEFAULT 0,
                publication_end_date DATETIME DEFAULT NULL,
                is_best_seller INTEGER DEFAULT 0,
                is_offer INTEGER DEFAULT 0,
                is_trending INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'products' table ready.");
        
        // 3. Tabla PRODUCT_STOCK (Credenciales y Stock Detallado)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS product_stock (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                provider_user_id INTEGER NOT NULL,
                sold_to_user_id INTEGER,
                data TEXT,
                is_sold INTEGER DEFAULT 0,
                sold_at DATETIME,
                client_name TEXT,
                client_phone TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'product_stock' table ready.");

        // 4. Tabla CATEGORIES
        await client.execute(`
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                logo_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                discount_premium_percentage INTEGER DEFAULT 0
            );
        `);
        console.log("✅ Database: 'categories' table ready.");
        
        // 🟢 MIGRACIÓN: Verificar y agregar 'discount_premium_percentage' si falta
        try {
            await client.execute("SELECT discount_premium_percentage FROM categories LIMIT 1");
        } catch (e) {
            console.log("🟡 Migrating: Adding 'discount_premium_percentage' column to categories table...");
            await client.execute("ALTER TABLE categories ADD COLUMN discount_premium_percentage INTEGER DEFAULT 0");
            console.log("✅ Migration successful: 'discount_premium_percentage' column added.");
        }


        // 5. Tabla ORDERS (Para productos 'A pedido')
        await client.execute(`
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchase_id TEXT UNIQUE NOT NULL,
                buyer_user_id INTEGER NOT NULL,
                provider_user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                total_price REAL NOT NULL,
                status TEXT DEFAULT 'Pending' NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'orders' table ready.");

        // 6. Tabla WITHDRAWALS (Retiros de Proveedores)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount_original REAL NOT NULL,
                amount_final REAL NOT NULL,
                status TEXT DEFAULT 'Pending' NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'withdrawals' table ready.");
        
        // 7. Tabla TRANSACTION_LOGS (Mantener por si acaso)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS transaction_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database: 'transaction_logs' table ready.");
        
        // 8. 🔑 Tabla SETTINGS (para la Tasa de Cambio y otras configs)
        await client.execute(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        console.log("✅ Database: 'settings' table ready.");


    } catch (error) {
        console.error("❌ Error initializing database:", error);
    }
}

/**
 * Inserta un usuario administrador si no existe o actualiza sus credenciales si ya existe.
 */
export async function seedAdminUser() {
    const adminEmail = process.env.VITE_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin928$%%%3_Xos923__s%%@gmail.com'; 
    const adminPassword = process.env.VITE_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'adminmelu31222121'; 
    const adminReferralCode = 'ADM001'; 
    
    const hashedPassword = await bcrypt.hash(adminPassword, 10); 

    try {
        const check = await client.execute({
            sql: 'SELECT id FROM users WHERE email = ?',
            args: [adminEmail]
        });

        if (check.rows.length === 0) {
            // 1. SEMBRAR
            await client.execute({
                sql: `INSERT INTO users (username, email, phone, password_hash, plain_password, role, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: ['AdminMelu', adminEmail, '5551234567', hashedPassword, adminPassword, 'Admin', adminReferralCode]
            });
            console.log(`✅ Admin user created with email: ${adminEmail}.`);
        } else {
            // 2. ACTUALIZAR
             await client.execute({
                sql: `UPDATE users SET password_hash = ?, plain_password = ?, referral_code = ? WHERE email = ?`,
                args: [hashedPassword, adminPassword, adminReferralCode, adminEmail]
            });
            console.log("✅ Admin user credentials updated/ensured.");
        }
        
        // 3. 🔑 [NUEVO] Sembrar Tasa de Cambio (Default 3.65)
        const rateCheck = await client.execute("SELECT value FROM settings WHERE key = 'exchange_rate'");
        if (rateCheck.rows.length === 0) {
            await client.execute({
                sql: "INSERT INTO settings (key, value) VALUES ('exchange_rate', ?)",
                args: ['3.65'] 
            });
            console.log("✅ Settings: Initial 'exchange_rate' set to 3.65.");
        } else {
            console.log("✅ Settings: 'exchange_rate' already exists.");
        }

    } catch (error) {
        console.error("❌ Error seeding/updating admin user:", error);
    }
}

/**
 * 🟢 FUNCIÓN DE MIGRACIÓN: Asignar códigos de referido a usuarios existentes sin uno
 */
export async function assignReferralCodesToExistingUsers() {
    try {
        console.log("🟡 Database: Checking for users without personal referral codes...");
        
        const usersWithoutCode = await client.execute(`
            SELECT id, username FROM users WHERE referral_code IS NULL OR referral_code = ''
        `);

        if (usersWithoutCode.rows.length === 0) {
            console.log("✅ Database: All existing users have referral codes.");
            return;
        }

        console.log(`🟡 Database: Found ${usersWithoutCode.rows.length} users requiring a referral code.`);

        for (const user of usersWithoutCode.rows) {
            let uniqueCode = '';
            let isUnique = false;
            let attempts = 0;
            
            while (!isUnique && attempts < 5) {
                uniqueCode = generateRandomCode(6);
                const existingCode = await client.execute({
                    sql: 'SELECT id FROM users WHERE referral_code = ?',
                    args: [uniqueCode]
                });
                if (existingCode.rows.length === 0) isUnique = true;
                attempts++;
            }

            if (isUnique) {
                await client.execute({
                    sql: 'UPDATE users SET referral_code = ? WHERE id = ?',
                    args: [uniqueCode, user.id]
                });
            }
        }
        console.log("✅ Database: Referral codes assigned to missing users.");

    } catch (error) {
        console.error("❌ Error assigning referral codes to existing users:", error);
    }
}