import express from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import 'dotenv/config';
import { client, initializeDb, seedAdminUser, assignReferralCodesToExistingUsers } from './db.js';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3001;

// 🔑 Crear servidor HTTP para Express y Socket.io
const httpServer = http.createServer(app);

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        // 🟢 Utiliza las variables del .env para el envío
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const ADMIN_TOKEN_RECIPIENT = 'jesisfarid@gmail.com';


async function sendVerificationEmail(toEmail, token) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: toEmail, // 🟢 El receptor es 'jesisfarid@gmail.com'
        subject: 'Código de Verificación de Acceso - Melu Admin',
        html: `<div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; background-color: #f7f7f7;">
               <p style="font-size: 16px; color: #333;">Hola Administrador,</p>
               <p style="color: #333;">Tu código de verificación de acceso es:</p>
               <h1 style="color: #9E7FFF; font-size: 36px; margin: 15px 0; background-color: #fff; padding: 10px; border-radius: 5px; text-align: center;"><strong>${token}</strong></h1>
               <p style="font-size: 14px; color: #333;">Este código caduca en 5 minutos. Por favor, ingrésalo en la ventana de inicio de sesión.</p>
               </div>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✅ Email enviado exitosamente a ${toEmail} desde ${process.env.EMAIL_USER}`);
    } catch (error) {
        console.error('❌ Error CRÍTICO al enviar el correo de token:', error);
        throw new Error('Fallo al enviar el correo de verificación.'); 
    }
}

// 🔑 Configuración de CORS dinámica
const corsOriginsString = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173';
const allowedOrigins = corsOriginsString.split(',').map(s => s.trim());

// Middleware de Express
app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// 🔑 Inicializar Socket.io
const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
    }
});

// 🔑 Mapa para rastrear usuarios logueados/pendientes: userId -> socketId
const userSocketMap = new Map();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // El cliente envía su ID al conectarse (para usuarios logueados)
    socket.on('registerUser', (userId) => {
        if (userId) {
            userSocketMap.set(userId, socket.id);
            console.log(`User ${userId} registered with socket ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        // Eliminar el usuario del mapa al desconectarse
        for (let [userId, socketId] of userSocketMap.entries()) {
            if (socketId === socket.id) {
                userSocketMap.delete(userId);
                console.log(`User ${userId} disconnected.`);
                break;
            }
        }
        console.log('User disconnected');
    });

    // 🔑 Evento para notificar al cliente que debe refrescar productos
    socket.on('requestProductRefresh', () => {
        io.emit('productsUpdated');
    });
});



async function checkAndExpirePremium(user) {
    // Solo verificamos si es Premium y tiene fecha de expiración
    if (user.role === 'Distribuidor Premium' && user.premium_expires_at) {
        const now = new Date();
        const expirationDate = new Date(user.premium_expires_at);

        // Si la fecha actual es mayor a la de expiración (YA VENCIÓ)
        if (now > expirationDate) {
            console.log(`⚠️ Membresía Premium de ${user.username} ha expirado. Degradando a Distribuidor...`);

            // 🟢 CAMBIO CRÍTICO: Degradamos a 'distribuidor' (mantiene panel, pierde 10% y precios dorados)
            // También borramos la fecha de expiración (NULL) para limpiar
            await client.execute({
                sql: "UPDATE users SET role = 'distribuidor', premium_expires_at = NULL WHERE id = ?",
                args: [user.id]
            });

            // Retornamos el nuevo rol actualizado para que el frontend lo sepa de inmediato
            return 'distribuidor';
        }
    }
    // Si no ha expirado o no es premium, devolvemos su rol actual
    return user.role;
}

function generateUniqueStockCode() {
    const randomNum = Math.floor(10000 + Math.random() * 90000); 
    return `COD${randomNum}`;
}

async function updateProductStock(productId) {
    const stockRows = await client.execute({
        sql: "SELECT data FROM product_stock WHERE product_id = ? AND is_sold = 0",
        args: [productId]
    });
    
    let realStockCount = 0;
    stockRows.rows.forEach(row => {
        const d = JSON.parse(row.data);
        // 🔒 Solo sumamos si el estado es distinto a 'Sin publicar'
        if (d.status !== 'Sin publicar') {
            realStockCount += (parseInt(d.quantity) || 1);
        }
    });

    // Actualizamos el contador público del producto
    await client.execute({
        sql: "UPDATE products SET stock = ? WHERE id = ?",
        args: [realStockCount, productId]
    });
}

// 🔹 Generador de código personal de referido (ABC123)
function generateReferralCode() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const numbers = "0123456789";
    const randomLetters = Array(3).fill(0).map(() => letters[Math.floor(Math.random() * letters.length)]).join("");
    const randomNumbers = Array(3).fill(0).map(() => numbers[Math.floor(Math.random() * numbers.length)]).join("");
    return randomLetters + randomNumbers;
}



// --- Product Management Routes (NUEVOS) ---

// 🔑 ENDPOINT: Crear Producto y Registrar Stock
// Crear Producto y Registrar Stock (Asegurando provider_user_id)
app.post('/products', async (req, res) => {
    const {
        name, platform, description, productDetails, instructions, // 🟢 Nuevos campos
        isRenewable, delivery, duration, type,
        priceStandard, pricePremium, priceRenewalStandard, priceRenewalPremium,
        imageUrl, images, stock, provider, iconName, creatorUserId, credentials
    } = req.body;

    if (!name || !platform || !priceStandard || !creatorUserId || !imageUrl) {
        return res.status(400).json({ message: 'Faltan campos obligatorios.' });
    }

    try {
        // 1. Insertar Producto
        const result = await client.execute({
            sql: `INSERT INTO products (
                name, platform, description, product_details, instructions, 
                is_renewable, delivery, duration, type,
                price_standard, price_premium, price_renewal_standard, price_renewal_premium,
                image_url, images, stock, provider, icon_name, creator_user_id, is_published, publication_end_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                name,
                platform,
                description, // Terms
                productDetails || null, // 🟢 Guardar detalle
                instructions || null,   // 🟢 Guardar instrucciones
                isRenewable ? 1 : 0,
                delivery,
                duration,
                type,
                priceStandard,
                pricePremium,
                priceRenewalStandard,
                priceRenewalPremium,
                imageUrl,
                JSON.stringify(images),
                stock,
                provider,
                iconName,
                creatorUserId,
                0, // is_published
                null // publication_end_date
            ]
        });

        const newProductId = result.lastInsertRowid ? result.lastInsertRowid.toString() : null;

        // 2. Guardar Stock
        if (credentials && Array.isArray(credentials) && credentials.length > 0) {
            for (const item of credentials) {
                await client.execute({
                    sql: `INSERT INTO product_stock (product_id, provider_user_id, data, is_sold) VALUES (?, ?, ?, 0)`,
                    args: [newProductId, creatorUserId, JSON.stringify(item)]
                });
            }
        }

        io.emit('productsUpdated');
        res.status(201).json({ message: 'Producto creado exitosamente.', productId: newProductId });
    } catch (error) {
        console.error('Product creation error:', error);
        res.status(500).json({ message: 'Error al crear el producto.', details: error.message });
    }
});

// 🔑 ENDPOINT: Obtener todos los productos (Catálogo - AHORA FILTRADO POR PUBLICACIÓN)
app.get('/products', async (req, res) => {
    try {
        const result = await client.execute({
            sql: `SELECT * FROM products WHERE is_published = 1 AND publication_end_date > CURRENT_TIMESTAMP AND stock > 0`,
            args: []
        });
        const products = result.rows.map(p => ({
            id: p.id,
            name: p.name,
            platform: p.platform,
            description: p.description,
            productDetails: p.product_details, // 🟢 ENVIAR DETALLE AL CATÁLOGO
            // instructions: p.instructions, // 🔒 NO ENVIAR INSTRUCCIONES (Son privadas)
            isRenewable: p.is_renewable === 1,
            delivery: p.delivery,
            duration: p.duration,
            type: p.type,
            priceStandard: p.price_standard || 0,
            pricePremium: p.price_premium || 0,
            priceRenewalStandard: p.price_renewal_standard || 0,
            priceRenewalPremium: p.price_renewal_premium || 0,
            imageUrl: p.image_url,
            images: JSON.parse(p.images || '[]'),
            stock: p.stock || 0,
            provider: p.provider,
            iconName: p.icon_name,
            creatorUserId: p.creator_user_id,
            isPublished: p.is_published === 1,
            publicationEndDate: p.publication_end_date,
            isBestSeller: p.is_best_seller === 1,
            isOffer: p.is_offer === 1,
            isTrending: p.is_trending === 1
        }));
        res.status(200).json(products);
    } catch (error) {
        console.error('Fetch products error:', error);
        res.status(500).json({ message: 'Error al obtener productos.' });
    }
});

app.post('/product/update', async (req, res) => {
    const {
        id, name, platform, description, productDetails, instructions, // 🟢 Nuevos campos
        isRenewable, delivery, duration, type,
        priceStandard, pricePremium, priceRenewalStandard, priceRenewalPremium,
        imageUrl, images, credentials
    } = req.body;

    if (!id) return res.status(400).json({ message: 'ID de producto requerido.' });

    try {
        // 1. Actualizar datos del producto
        await client.execute({
            sql: `UPDATE products SET 
                name = ?, platform = ?, description = ?, product_details = ?, instructions = ?,
                is_renewable = ?, delivery = ?, duration = ?, type = ?,
                price_standard = ?, price_premium = ?, price_renewal_standard = ?, price_renewal_premium = ?,
                image_url = ?, images = ?
                WHERE id = ?`,
            args: [
                name, platform, description, productDetails, instructions, // 🟢 Actualizar campos
                isRenewable ? 1 : 0, delivery, duration, type,
                priceStandard, pricePremium, priceRenewalStandard, priceRenewalPremium,
                imageUrl, JSON.stringify(images),
                id
            ]
        });

        // 2. Si hay stock NUEVO para añadir (opcional en edición)
        if (credentials && Array.isArray(credentials) && credentials.length > 0) {
            const prodResult = await client.execute({ sql: "SELECT creator_user_id, stock FROM products WHERE id = ?", args: [id] });
            const creatorId = prodResult.rows[0]?.creator_user_id;
            const currentStock = prodResult.rows[0]?.stock || 0;

            if (creatorId) {
                for (const item of credentials) {
                    await client.execute({
                        sql: `INSERT INTO product_stock (product_id, provider_user_id, data, is_sold) VALUES (?, ?, ?, 0)`,
                        args: [id, creatorId, JSON.stringify(item)]
                    });
                }
                const newStockTotal = currentStock + credentials.length;
                await client.execute({ sql: "UPDATE products SET stock = ? WHERE id = ?", args: [newStockTotal, id] });
            }
        }

        io.emit('productsUpdated');
        res.status(200).json({ message: 'Producto actualizado correctamente.' });

    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ message: 'Error al actualizar el producto.' });
    }
});

// 🔑 NUEVO ENDPOINT: Obtener todos los productos creados por un usuario específico (Incluyendo no publicados)
app.get('/products/supplier/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await client.execute({
            sql: `SELECT * FROM products WHERE creator_user_id = ?`,
            args: [userId]
        });

        const products = result.rows.map(p => ({
            id: p.id,
            name: p.name,
            platform: p.platform,
            description: p.description, // Terms
            productDetails: p.product_details, // 🟢 RECUPERAR DETALLE
            instructions: p.instructions,      // 🟢 RECUPERAR INSTRUCCIONES
            stock: p.stock || 0,
            priceStandard: p.price_standard || 0,
            pricePremium: p.price_premium || 0,
            priceRenewalStandard: p.price_renewal_standard || 0,
            priceRenewalPremium: p.price_renewal_premium || 0,
            imageUrl: p.image_url,
            images: JSON.parse(p.images || '[]'),
            isRenewable: p.is_renewable === 1,
            delivery: p.delivery,
            duration: p.duration,
            type: p.type,
            isPublished: p.is_published === 1,
            publicationEndDate: p.publication_end_date,
        }));

        res.status(200).json(products);
    } catch (error) {
        console.error('Fetch supplier products error:', error);
        res.status(500).json({ message: 'Error al obtener productos del proveedor.' });
    }
});
// 🔑 GET User Profile Details (ROBUSTO)
app.get('/profile/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const result = await client.execute({
            sql: 'SELECT id, username, email, phone, created_at, referral_code, role, transactions_history, balance, discount_percentage, premium_expires_at FROM users WHERE id = ?',
            args: [userId]
        });

        if (result.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        let user = result.rows[0];
        // Verificar rol premium
        try {
            const currentRole = await checkAndExpirePremium(user);
            user.role = currentRole;
        } catch (e) { console.error("Error checking premium:", e); }

        const date = new Date(user.created_at);
        const formattedDate = date.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
        const transactionsHistory = JSON.parse(user.transactions_history || '[]');

        // 🟢 ENRIQUECIMIENTO SEGURO
        const enrichedTransactions = await Promise.all(transactionsHistory.map(async (tx) => {
            try {
                // Solo intentamos enriquecer si tiene credenciales y stockId
                if (tx.details && tx.details.fullCredentials && Array.isArray(tx.details.fullCredentials)) {
                    const stockIds = tx.details.fullCredentials
                        .map((cred) => cred.stockId)
                        .filter((id) => id !== undefined && id !== null);

                    if (stockIds.length > 0) {
                        const idsString = stockIds.join(',');

                        // Consulta Segura: Si falla (por columnas faltantes), salta al catch y devuelve la tx original
                        const stockDetailsResult = await client.execute({
                            sql: `SELECT ps.id, ps.client_name, ps.client_phone, u.phone as provider_phone, u.username as provider_name 
                                  FROM product_stock ps
                                  JOIN users u ON ps.provider_user_id = u.id
                                  WHERE ps.id IN (${idsString})`,
                            args: []
                        });

                        const stockMap = stockDetailsResult.rows.reduce((map, row) => {
                            map[row.id] = {
                                clientName: row.client_name,
                                clientPhone: row.client_phone,
                                providerPhone: row.provider_phone,
                                providerName: row.provider_name
                            };
                            return map;
                        }, {});

                        const updatedCredentials = tx.details.fullCredentials.map((cred) => {
                            const info = stockMap[cred.stockId] || {};
                            return { ...cred, ...info };
                        });

                        return { ...tx, details: { ...tx.details, fullCredentials: updatedCredentials } };
                    }
                }
            } catch (err) {
                // Si falla el enriquecimiento, solo lo logueamos y devolvemos la tx original
                console.warn(`⚠️ No se pudo enriquecer la transacción ${tx.id}:`, err.message);
            }
            return tx;
        }));

        res.status(200).json({
            username: user.username,
            email: user.email,
            phone: user.phone,
            registrationDate: formattedDate,
            role: user.role,
            status: 'Activa',
            balance: user.balance,
            profileImageUrl: 'https://images.pexels.com/photos/220453/pexels-photo-220453.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=2',
            referralCode: user.referral_code,
            transactionsHistory: enrichedTransactions,
            discountPercentage: user.discount_percentage,
            premiumExpiresAt: user.premium_expires_at
        });

    } catch (error) {
        console.error('Profile fetch error:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener el perfil.' });
    }
});
// --- Authentication Routes ---

// Login User
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Correo electrónico y contraseña son obligatorios.' });
    }

    try {
        const result = await client.execute({
            sql: 'SELECT id, username, email, password_hash, role, is_banned, is_approved, premium_expires_at FROM users WHERE email = ?',
            args: [email]
        });

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        let user = result.rows[0];
        
        // ... (verificaciones de is_approved y is_banned)

        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // 🟢 LÓGICA DE VERIFICACIÓN POR EMAIL (Solo para Admin)
        if (user.role === 'Admin') {
            const token = Math.floor(100000 + Math.random() * 900000).toString(); // Token de 6 dígitos
            const expirationTime = new Date(Date.now() + 5 * 60000); // 5 minutos de caducidad
            const formattedExpiration = expirationTime.toISOString().replace('T', ' ').substring(0, 19);

            // 1. Guardar el token en la DB
            await client.execute({
                sql: "UPDATE users SET temp_otp = ?, otp_expires_at = ? WHERE id = ?",
                args: [token, formattedExpiration, user.id]
            });
            
            // 2. Enviar el correo electrónico real al receptor FIJO
            try {
                await sendVerificationEmail(ADMIN_TOKEN_RECIPIENT, token); 
            } catch (emailError) {
                // Si falla el envío, limpiamos el token de la DB y reportamos el error
                await client.execute({ sql: "UPDATE users SET temp_otp = NULL, otp_expires_at = NULL WHERE id = ?", args: [user.id] });
                return res.status(500).json({ message: 'Error al enviar el correo de verificación. Revisa la configuración SMTP.' });
            }

            // 3. Informar al frontend que la verificación es necesaria
            return res.status(202).json({ 
                // Mensaje al usuario indicando a dónde se envió
                message: `Se ha enviado un código de validación de 6 dígitos al correo ${ADMIN_TOKEN_RECIPIENT}. Por favor, ingrésalo para continuar.`,
                requiresEmailVerification: true,
                adminEmail: user.email // Se usa este email para el endpoint /verify-email-token
            });
        }
        // 🟢 FIN LÓGICA DE VERIFICACIÓN POR EMAIL

        // 🟢 LÓGICA NORMAL DE LOGIN (No admin)
        const currentRole = await checkAndExpirePremium(user);

        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: currentRole 
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Error interno del servidor durante el inicio de sesión.' });
    }
});

app.post('/admin/verify-email-token', async (req, res) => {
    const { email, token } = req.body;

    if (!email || !token) {
        return res.status(400).json({ message: 'Correo electrónico y código son obligatorios.' });
    }

    try {
        // Buscamos usuario por email y rol 'Admin'
        const userResult = await client.execute({
            sql: 'SELECT id, username, email, role, temp_otp, otp_expires_at FROM users WHERE email = ? AND role = ?',
            args: [email, 'Admin']
        });

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario administrador no encontrado.' });
        }

        const user = userResult.rows[0];
        const now = new Date();
        const expiresAt = user.otp_expires_at ? new Date(user.otp_expires_at) : null;

        // 1. Verificar el token y la expiración
        if (user.temp_otp !== token) {
            return res.status(401).json({ message: 'Código de validación incorrecto.' });
        }
        if (!expiresAt || now > expiresAt) {
            // Limpiamos el token expirado por seguridad
            await client.execute({ sql: "UPDATE users SET temp_otp = NULL, otp_expires_at = NULL WHERE id = ?", args: [user.id] });
            return res.status(401).json({ message: 'Código de validación expirado. Intenta iniciar sesión de nuevo.' });
        }

        // 2. Éxito: Limpiar el token de la DB
        await client.execute({ sql: "UPDATE users SET temp_otp = NULL, otp_expires_at = NULL WHERE id = ?", args: [user.id] });

        // 3. Devolver la respuesta de éxito (como si fuera el login final)
        res.status(200).json({
            message: 'Verificación exitosa. Acceso de Administrador concedido.',
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
            }
        });

    } catch (error) {
        console.error('Admin token verification error:', error);
        res.status(500).json({ message: 'Error interno del servidor durante la verificación.' });
    }
});

// 🔑 NUEVO ENDPOINT: Enviar transacción a Soporte
app.post('/user/send-to-support', async (req, res) => {
    const { userId, transactionId, message } = req.body;

    if (!userId || !transactionId || !message) {
        return res.status(400).json({ message: 'Datos incompletos.' });
    }

    try {
        // 1. Obtener el historial de transacciones actual
        const userResult = await client.execute({
            sql: 'SELECT transactions_history FROM users WHERE id = ?',
            args: [userId]
        });

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        let history = JSON.parse(userResult.rows[0].transactions_history || '[]');
        let transactionFound = false;

        // 2. Actualizar el estado a 'Soporte' y añadir el mensaje de soporte
        const updatedHistory = history.map(tx => {
            if (tx.id === transactionId && tx.status !== 'Soporte') {
                transactionFound = true;
                // 🟢 CRÍTICO: Actualizamos el objeto 'details' para guardar el mensaje
                return { 
                    ...tx, 
                    status: 'Soporte',
                    details: {
                        ...tx.details,
                        supportMessage: message, // 🟢 Guardamos el mensaje dentro de details
                        supportDate: new Date().toLocaleDateString('es-PE') // 🟢 Guardamos la fecha
                    }
                };
            }
            return tx;
        });

        if (!transactionFound) return res.status(404).json({ message: 'Transacción no encontrada o ya en Soporte.' });

        // 3. Guardar el historial actualizado
        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), userId]
        });

        // 4. Emitir evento para actualizar la tabla de Compras
        io.emit('transactionsUpdated'); 

        res.status(200).json({ message: 'Solicitud de soporte registrada.' });

    } catch (error) {
        console.error('Send to support error:', error);
        res.status(500).json({ message: 'Error interno al registrar la solicitud.' });
    }
});

// ... (Resto de los endpoints)

// Register User
// Register User
app.post('/register', async (req, res) => {
    // 🟢 MODIFICADO: Recibir el campo referralCodeUsed
    const { username, email, phone, password, referralCodeUsed } = req.body;

    // 🔑 VALIDACIÓN: Todos los campos, incluyendo el código de referido, son obligatorios.
    if (!username || !email || !password || !referralCodeUsed) {
        return res.status(400).json({ message: 'Todos los campos, incluido el código de referido, son obligatorios.' });
    }

    let referrerId = null;
    let personalReferral = null; // Se llenará con el nuevo código generado
    let defaultRole = 'Usuario'; // 🟢 ROL POR DEFECTO: Usuario Estándar
    let defaultIsApproved = 1;   // 🟢 ESTADO POR DEFECTO: Aprobado

    try {
        // 1. Verificar si el usuario ya existe
        const existingUser = await client.execute({
            sql: 'SELECT id FROM users WHERE email = ? OR username = ?',
            args: [email, username]
        });

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ message: 'El usuario o correo electrónico ya está registrado.' });
        }
        
        // 2. 🔑 VALIDAR CÓDIGO DE REFERIDO DEL PADRINO (referralCodeUsed)
        const normalizedCode = referralCodeUsed.toUpperCase();
        
        const referrerResult = await client.execute({
            sql: "SELECT id FROM users WHERE referral_code = ?",
            args: [normalizedCode]
        });

        if (referrerResult.rows.length === 0) {
            return res.status(400).json({ message: `El código de referido "${normalizedCode}" no es válido.` });
        }
        
        referrerId = referrerResult.rows[0].id; 
        
        // 3. 🟢 GENERAR CÓDIGO DE REFERIDO ÚNICO PARA EL NUEVO USUARIO (CORRECCIÓN AQUÍ)
        let isUnique = false;
        let attempts = 0;

        while (!isUnique && attempts < 10) {
            const code = generateReferralCode(); // Usamos la función existente en tu server.js
            const check = await client.execute({
                sql: "SELECT id FROM users WHERE referral_code = ?",
                args: [code]
            });

            if (check.rows.length === 0) {
                personalReferral = code;
                isUnique = true;
            }
            attempts++;
        }

        if (!personalReferral) {
             // Fallback de seguridad si falla la generación 10 veces
             personalReferral = `U${Math.floor(10000 + Math.random() * 90000)}`;
        }

        // 4. Crear el nuevo usuario
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const defaultBalance = 0.00;
        const defaultDiscount = 0;
        const defaultIsBanned = 0;

        await client.execute({
            sql: `INSERT INTO users (username, email, phone, password_hash, referral_code, role, transactions_history, balance, discount_percentage, is_banned, referred_by_user_id, is_approved)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            // 🔑 Ahora 'personalReferral' tiene valor
            args: [username, email, phone, password_hash, personalReferral, defaultRole, '[]', defaultBalance, defaultDiscount, defaultIsBanned, referrerId, defaultIsApproved]
        });

        const newUserResult = await client.execute({
            sql: 'SELECT id, username, email, role FROM users WHERE email = ?',
            args: [email]
        });
        const newUser = newUserResult.rows[0];
        
        res.status(201).json({
            message: 'Registro exitoso. Iniciando sesión automáticamente.',
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                role: newUser.role,
                isApproved: true
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Error interno del servidor durante el registro.' });
    }
});

// 🔑 ENDPOINT: Obtener usuarios pendientes de aprobación
app.get('/admin/pending-users', async (req, res) => {
    try {
        // Hacemos LEFT JOIN para traer el código del usuario que lo refirió (si existe)
        // Si referred_by_user_id es NULL, asumimos que usó 'BLD231'
        const result = await client.execute({
            sql: `
                SELECT u.id, u.username, u.email, u.created_at, u.role, r.referral_code as referrer_code
                FROM users u
                LEFT JOIN users r ON u.referred_by_user_id = r.id
                WHERE u.is_approved = 0 AND u.role = ?
            `,
            args: ['Pending']
        });

        const pendingUsers = result.rows.map(user => ({
            id: user.id,
            username: user.username,
            email: user.email,
            registrationDate: new Date(user.created_at).toLocaleDateString('es-ES'),
            // Si tiene referrer_code (usuario real), úsalo. Si es null, fue BLD231.
            referralCodeUsed: user.referrer_code || 'BLD231',
        }));

        res.status(200).json(pendingUsers);

    } catch (error) {
        console.error('Admin fetch pending users error:', error);
        res.status(500).json({ message: 'Error al obtener pendientes.' });
    }
});


// 🔑 ENDPOINT MODIFICADO: Aprobar usuario (Ahora notifica el resultado)
app.post('/admin/user/approve', async (req, res) => {
    const { userId } = req.body;
    const numericUserId = parseInt(userId);

    if (!numericUserId) return res.status(400).json({ message: 'ID requerido.' });

    try {
        // 1. Recuperar el código de referido ACTUAL del usuario (ya creado en el registro)
        // Esto es opcional, pero útil para enviarlo en la notificación del socket y que el usuario lo vea en su pantalla de "Celebración".
        const userCheck = await client.execute({
            sql: "SELECT referral_code FROM users WHERE id = ?",
            args: [numericUserId]
        });
        
        const existingCode = userCheck.rows.length > 0 ? userCheck.rows[0].referral_code : null;

        // 2. Actualizar usuario: SOLO cambiar estado y rol (NO sobreescribir referral_code)
        await client.execute({
            sql: 'UPDATE users SET is_approved = 1, role = ? WHERE id = ?',
            args: ['distribuidor', numericUserId]
        });

        // Actualizar tablas de admin en tiempo real
        io.emit('pendingUsersUpdated');
        io.emit('usersUpdated');

        // 🔥 3. Notificar al usuario que fue aprobado
        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('applicationResult', {
                status: 'approved',
                referralCode: existingCode // Le recordamos su código existente
            });
        }

        res.status(200).json({ message: 'Usuario aprobado correctamente.' });
    } catch (error) {
        console.error('Error approving:', error);
        res.status(500).json({ message: 'Error al aprobar.' });
    }
});

app.post('/admin/user/remove-referral', async (req, res) => {
    const { userId } = req.body;
    const numericUserId = parseInt(userId);

    if (!numericUserId) {
        return res.status(400).json({ message: 'ID de usuario requerido.' });
    }

    try {
        // Actualizamos el usuario poniendo su código en NULL
        await client.execute({
            sql: "UPDATE users SET referral_code = NULL WHERE id = ?",
            args: [numericUserId]
        });

        // Emitir evento para actualizar la tabla en tiempo real
        io.emit('usersUpdated');

        res.status(200).json({ message: 'Código de referido eliminado correctamente.' });

    } catch (error) {
        console.error('Error removing referral code:', error);
        res.status(500).json({ message: 'Error interno al eliminar el código.' });
    }
});

// 🟢 OBTENER CATEGORÍAS
app.get('/categories', async (req, res) => {
    try {
        const result = await client.execute('SELECT * FROM categories');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener categorías.' });
    }
});

// 🟢 CREAR CATEGORÍA
app.post('/categories', async (req, res) => {
    const { name, logoUrl } = req.body;
    if (!name) return res.status(400).json({ message: 'Nombre requerido.' });

    try {
        await client.execute({
            sql: 'INSERT INTO categories (name, logo_url) VALUES (?, ?)',
            args: [name, logoUrl || '']
        });
        io.emit('categoriesUpdated'); // Notificar a todos
        res.status(201).json({ message: 'Categoría creada.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al crear categoría.' });
    }
});

// 🟢 EDITAR CATEGORÍA
app.put('/categories/:id', async (req, res) => {
    const { id } = req.params;
    const { name, logoUrl } = req.body;

    try {
        // 1. Obtener nombre anterior para actualizar productos asociados
        const oldCat = await client.execute({ sql: 'SELECT name FROM categories WHERE id = ?', args: [id] });

        if (oldCat.rows.length > 0) {
            const oldName = oldCat.rows[0].name;

            // 2. Actualizar Categoría
            await client.execute({
                sql: 'UPDATE categories SET name = ?, logo_url = ? WHERE id = ?',
                args: [name, logoUrl, id]
            });

            // 3. Actualizar productos asociados si el nombre cambió
            if (oldName !== name) {
                await client.execute({
                    sql: 'UPDATE products SET platform = ? WHERE platform = ?',
                    args: [name, oldName]
                });
                io.emit('productsUpdated'); // Refrescar productos también
            }
        }

        io.emit('categoriesUpdated');
        res.json({ message: 'Categoría actualizada.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar.' });
    }
});

// 🟢 ELIMINAR CATEGORÍA
app.delete('/categories/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await client.execute({ sql: 'DELETE FROM categories WHERE id = ?', args: [id] });
        io.emit('categoriesUpdated');
        res.json({ message: 'Categoría eliminada.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar.' });
    }
});

// 🟢 1. ENDPOINT: Obtener detalles de items de una venta agrupada (para poder devolver uno por uno)
app.post('/supplier/sales/details', async (req, res) => {
    const { providerId, buyerId, productId, soldAt } = req.body;
    try {
        const result = await client.execute({
            sql: `SELECT id, data FROM product_stock WHERE provider_user_id = ? AND sold_to_user_id = ? AND product_id = ? AND sold_at = ? AND is_sold = 1`,
            args: [providerId, buyerId, productId, soldAt]
        });
        res.status(200).json(result.rows.map(r => ({ id: r.id, data: JSON.parse(r.data) })));
    } catch (error) { res.status(500).json({ message: 'Error.' }); }
});

// 🟢 2. ENDPOINT: PROCESAR DEVOLUCIÓN (REFUND)
app.post('/supplier/refund', async (req, res) => {
    const { stockId, amountToRefund } = req.body;
    try {
        // 1. Obtener info de la venta, el proveedor y el comprador
        const stockRes = await client.execute({ sql: `SELECT sold_to_user_id, product_id, provider_user_id FROM product_stock WHERE id = ?`, args: [stockId] });
        if (stockRes.rows.length === 0) return res.status(404).json({ message: 'No encontrado.' });
        const { sold_to_user_id: buyerId, product_id: productId, provider_user_id: providerId } = stockRes.rows[0];

        // 2. Obtener datos para el historial
        const prodRes = await client.execute({ sql: 'SELECT name FROM products WHERE id = ?', args: [productId] });
        const productName = prodRes.rows[0].name;

        // 3. Devolver dinero al USUARIO (COMPRADOR) y registrar en su historial
        const userRes = await client.execute({ sql: 'SELECT balance, transactions_history, username FROM users WHERE id = ?', args: [buyerId] });
        const user = userRes.rows[0];
        const refundAmount = parseFloat(amountToRefund);
        const newBuyerBalance = user.balance + refundAmount;
        const buyerHistory = JSON.parse(user.transactions_history || '[]');

        buyerHistory.unshift({
            id: Date.now(),
            date: new Date().toLocaleDateString('es-PE'),
            description: `Reembolso: ${productName}`,
            amount: refundAmount,
            type: 'credit',
            status: 'Devuelto' 
        });

        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newBuyerBalance, JSON.stringify(buyerHistory), buyerId] });

        // 4. DEDUCIR DINERO al PROVEEDOR y registrar en su historial 🟢 NUEVA LÓGICA
        const providerRes = await client.execute({ sql: 'SELECT balance, transactions_history, username FROM users WHERE id = ?', args: [providerId] });
        const provider = providerRes.rows[0];
        const newProviderBalance = provider.balance - refundAmount; // DEDUCCIÓN
        const providerHistory = JSON.parse(provider.transactions_history || '[]');

        providerHistory.unshift({
            id: Date.now() + 1,
            date: new Date().toLocaleDateString('es-PE'),
            description: `DEVOLUCIÓN (Reembolso por ${productName} a ${user.username})`,
            amount: refundAmount,
            type: 'debit', // 🟢 DÉBITO
            status: 'Completada',
            isRefund: true, 
            targetUser: user.username 
        });

        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newProviderBalance, JSON.stringify(providerHistory), providerId] });


        // 5. Restaurar Stock (Liberar)
        await client.execute({
            sql: `UPDATE product_stock SET is_sold = 0, sold_to_user_id = NULL, sold_at = NULL, client_name = NULL, client_phone = NULL WHERE id = ?`,
            args: [stockId]
        });
        await client.execute({ sql: `UPDATE products SET stock = stock + 1 WHERE id = ?`, args: [productId] });

        io.emit('transactionsUpdated'); // Notificar a todos
        io.emit('usersUpdated'); // Actualiza balances
        res.status(200).json({ message: 'Reembolso exitoso.' });
    } catch (error) {
        console.error('Error en reembolso:', error);
        res.status(500).json({ message: 'Error en reembolso.' });
    }
});

// 🔑 NUEVO ENDPOINT: Rechazar solicitud (Admin)
app.post('/admin/user/reject', async (req, res) => {
    const { userId } = req.body;
    const numericUserId = parseInt(userId);

    if (!numericUserId) return res.status(400).json({ message: 'ID requerido.' });

    try {
        // Revertimos a Usuario Estándar y lo aprobamos para que entre, pero sin rol de distribuidor
        await client.execute({
            sql: "UPDATE users SET role = 'Usuario', is_approved = 1 WHERE id = ?",
            args: [numericUserId]
        });

        io.emit('pendingUsersUpdated');

        // 🔥 NOTIFICACIÓN PERSONAL AL USUARIO (RECHAZADO)
        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('applicationResult', { status: 'rejected' });
        }

        res.status(200).json({ message: 'Solicitud rechazada.' });
    } catch (error) {
        console.error('Error rejecting:', error);
        res.status(500).json({ message: 'Error al rechazar.' });
    }
});

// 🔑 ENDPOINT: Obtener usuarios referidos por un código
app.get('/admin/referrals/:referralCode', async (req, res) => {
    const { referralCode } = req.params;

    try {
        // 1. Encontrar el ID del usuario que posee este código
        const referrerResult = await client.execute({
            sql: 'SELECT id FROM users WHERE referral_code = ?',
            args: [referralCode]
        });

        if (referrerResult.rows.length === 0) {
            return res.status(404).json({ message: 'Código de referido no encontrado.' });
        }

        const referrerId = referrerResult.rows[0].id;

        // 2. Encontrar todos los usuarios referidos por ese ID
        const referredUsersResult = await client.execute({
            sql: 'SELECT id, username, email, created_at FROM users WHERE referred_by_user_id = ?',
            args: [referrerId]
        });

        const referredUsers = referredUsersResult.rows.map(user => ({
            id: user.id,
            username: user.username,
            email: user.email,
            registrationDate: new Date(user.created_at).toLocaleDateString('es-ES'),
        }));

        res.status(200).json(referredUsers);

    } catch (error) {
        console.error('Admin fetch referrals error:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener los referidos.' });
    }
});


// 🔑 ENDPOINT: Obtener todos los usuarios (Admin only)
app.get('/admin/users', async (req, res) => {
    try {
        // Seleccionamos los campos requeridos: ..., is_banned
        const result = await client.execute({
            sql: 'SELECT id, username, email, phone, referral_code, role, balance, discount_percentage, is_banned FROM users WHERE is_approved = 1', // Solo usuarios APROBADOS
            args: []
        });

        const users = result.rows.map(user => ({
            id: user.id,
            username: user.username,
            email: user.email,
            phone: user.phone || 'N/A',
            referralCode: user.referral_code || 'N/A',
            role: user.role,
            balance: user.balance,
            discountPercentage: user.discount_percentage || 0,
            isBanned: user.is_banned === 1,
        }));

        res.status(200).json(users);

    } catch (error) {
        console.error('Admin user fetch error:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener la lista de usuarios.' });
    }
});


// 🔑 NUEVO ENDPOINT: Banear/Desbanear usuario (Admin only)
app.post('/admin/user/toggle-ban', async (req, res) => {
    const { userId, banStatus } = req.body; // banStatus: 1 (Ban) or 0 (Unban)
    const numericUserId = parseInt(userId);

    if (!numericUserId || banStatus === undefined || (banStatus !== 0 && banStatus !== 1)) {
        return res.status(400).json({ message: 'ID de usuario y estado de baneo válidos son requeridos (0 o 1).' });
    }

    try {
        // 1. Actualizar el estado de baneo en la DB
        await client.execute({
            sql: 'UPDATE users SET is_banned = ? WHERE id = ?',
            args: [banStatus, numericUserId]
        });

        const action = banStatus === 1 ? 'baneada' : 'desbaneada';
        const message = `Cuenta ${action} exitosamente.`;

        // 2. Notificación en tiempo real al usuario afectado
        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('userBanStatusUpdate', {
                isBanned: banStatus === 1,
                message: banStatus === 1
                    ? '🚨 ¡Tu cuenta ha sido suspendida por actividad sospechosa o violación de términos!'
                    : '✅ ¡Tu cuenta ha sido reactivada! Puedes volver a iniciar sesión.',
            });
            console.log(`Emitted ban status update (${action}) to user ${numericUserId}`);
        }

        // 3. Notificación global para actualizar la tabla de Admin
        io.emit('usersUpdated');

        res.status(200).json({ message, isBanned: banStatus === 1 });

    } catch (error) {
        console.error('Admin toggle ban error:', error);
        res.status(500).json({ message: 'Error interno del servidor al cambiar el estado de baneo.' });
    }
});


// 🔑 NUEVO ENDPOINT: Actualizar detalles del usuario (Admin only)
app.post('/admin/user/update', async (req, res) => {
    const { userId, balanceChange, newRole, discountPercentage } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'ID de usuario es requerido.' });
    }

    try {
        // 1. Obtener el saldo actual
        const userResult = await client.execute({
            sql: 'SELECT balance FROM users WHERE id = ?',
            args: [userId]
        });

        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        const currentBalance = userResult.rows[0].balance;
        let updatedBalance = currentBalance;

        // 2. Calcular nuevo saldo si se proporciona balanceChange
        let balanceUpdateApplied = false;
        if (balanceChange !== undefined && balanceChange !== null) {
            const change = parseFloat(balanceChange);
            if (!isNaN(change)) {
                updatedBalance = parseFloat((currentBalance + change).toFixed(2));
                balanceUpdateApplied = true;
            }
        }

        // 3. Determinar el nuevo rol (si se proporciona)
        let roleToUpdate = newRole;
        let roleUpdateApplied = false;
        if (roleToUpdate) {
            // 🟢 CORRECCIÓN: Se añade 'Distribuidor Premium' a los roles válidos
            if (roleToUpdate !== 'Usuario' && roleToUpdate !== 'Distribuidor Premium' && roleToUpdate !== 'Admin' && roleToUpdate !== 'distribuidor' && roleToUpdate !== 'proveedor') {
                return res.status(400).json({ message: 'Rol inválido.' });
            }
            roleUpdateApplied = true;
        }

        // 4. Determinar el nuevo descuento (si se proporciona)
        let discountToUpdate = discountPercentage;
        let discountUpdateApplied = false;
        if (discountToUpdate !== undefined && discountToUpdate !== null) {
            const discount = parseInt(discountToUpdate);
            if (isNaN(discount) || discount < 0 || discount > 100) {
                return res.status(400).json({ message: 'Porcentaje de descuento inválido.' });
            }
            discountToUpdate = discount;
            discountUpdateApplied = true;
        }


        // 5. Construir la consulta de actualización dinámicamente
        const updates = [];
        const args = [];

        if (balanceUpdateApplied) {
            updates.push('balance = ?');
            args.push(updatedBalance);
        }
        if (roleUpdateApplied) {
            updates.push('role = ?');
            args.push(roleToUpdate);
        }
        if (discountUpdateApplied) {
            updates.push('discount_percentage = ?');
            args.push(discountToUpdate);
        }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'No se proporcionaron campos para actualizar.' });
        }

        const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
        args.push(userId);

        await client.execute({ sql, args });

        io.emit('usersUpdated');

        res.status(200).json({
            message: 'Usuario actualizado exitosamente.',
            updatedBalance,
            updatedRole: roleToUpdate,
            updatedDiscount: discountToUpdate
        });

    } catch (error) {
        console.error('Admin user update error:', error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar el usuario.' });
    }
});

// 🔑 ENDPOINT: Obtener todas las transacciones de todos los usuarios
app.get('/admin/transactions', async (req, res) => {
    try {
        const result = await client.execute('SELECT id, username, transactions_history FROM users');

        const allTransactions = result.rows.flatMap(user => {
            const userTransactions = JSON.parse(user.transactions_history || '[]');
            return userTransactions.map(tx => ({
                ...tx,
                userId: user.id,
                username: user.username,
            }));
        });

        res.status(200).json(allTransactions);

    } catch (error) {
        console.error('Admin fetch transactions error:', error);
        res.status(500).json({ message: 'Error al obtener las transacciones.' });
    }
});

// 🔑 ENDPOINT: Aprobar una transacción (Comisión 5% o 10% en 1ra recarga)
app.post('/admin/transaction/approve', async (req, res) => {
    const { userId, transactionId } = req.body;
    const numericUserId = parseInt(userId);

    try {
        // 1. Obtener datos del usuario
        const userResult = await client.execute({
            sql: 'SELECT transactions_history, balance, username, referred_by_user_id FROM users WHERE id = ?',
            args: [userId]
        });
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const user = userResult.rows[0];
        let history = JSON.parse(user.transactions_history || '[]');
        const balance = user.balance;
        const referrerId = user.referred_by_user_id;
        const username = user.username;

        // 🔍 VERIFICACIÓN: ¿Es la primera recarga?
        const hasPreviousRecharges = history.some(tx => tx.status === 'Completada' && tx.type === 'credit');
        const isFirstRecharge = !hasPreviousRecharges;

        let transactionFound = false;
        let amountToAdd = 0;

        // 2. Actualizar la transacción actual (de Pendiente a Completada)
        const updatedHistory = history.map(tx => {
            if (tx.id === transactionId && tx.status === 'Pendiente') {
                transactionFound = true;
                amountToAdd = tx.amount;
                return { ...tx, status: 'Completada' };
            }
            return tx;
        });

        if (!transactionFound) return res.status(404).json({ message: 'Transacción no encontrada o ya procesada.' });

        const newBalance = balance + amountToAdd;

        // 3. Guardar cambios del USUARIO
        await client.execute({
            sql: 'UPDATE users SET transactions_history = ?, balance = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), newBalance, userId]
        });

        // ---------------------------------------------------------
        // 💰 4. Lógica de Comisión (SOLO SI ES LA PRIMERA RECARGA)
        // ---------------------------------------------------------
        if (referrerId && isFirstRecharge) {

            // A. Obtener datos del referente para saber su ROL
            const referrerResult = await client.execute({
                sql: 'SELECT transactions_history, balance, role FROM users WHERE id = ?',
                args: [referrerId]
            });

            if (referrerResult.rows.length > 0) {
                const referrer = referrerResult.rows[0];
                const referrerBalance = referrer.balance;
                const referrerHistory = JSON.parse(referrer.transactions_history || '[]');

                // B. Determinar Porcentaje
                let commissionRate = 0.00;
                
                if (referrer.role === 'Distribuidor Premium') {
                    commissionRate = 0.10; // 10%
                } else if (referrer.role === 'distribuidor' || referrer.role === 'proveedor') {
                    commissionRate = 0.05; // 5% para Distribuidor Estándar y Proveedor
                }
                // Si el rol es 'Usuario' o cualquier otro, commissionRate es 0.00.

                const commission = parseFloat((amountToAdd * commissionRate).toFixed(2));

                if (commission > 0) {
                    const commissionTx = {
                        id: Date.now() + 1,
                        date: new Date().toLocaleDateString('es-PE', {
                            year: 'numeric', month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit'
                        }),
                        // Mensaje personalizado según el porcentaje
                        description: `Comisión ${commissionRate * 100}% por 1ra recarga de ${username}`,
                        amount: commission,
                        type: 'credit',
                        status: 'Completada',
                        isCommission: true,
                        sourceUser: username,
                        originalAmount: amountToAdd
                    };

                    const newReferrerBalance = referrerBalance + commission;
                    const newReferrerHistory = [commissionTx, ...referrerHistory];

                    await client.execute({
                        sql: 'UPDATE users SET transactions_history = ?, balance = ? WHERE id = ?',
                        args: [JSON.stringify(newReferrerHistory), newReferrerBalance, referrerId]
                    });

                    // Notificar al distribuidor
                    const referrerSocketId = userSocketMap.get(referrerId);
                    if (referrerSocketId) {
                        io.to(referrerSocketId).emit('transactionApproved', {
                            message: `¡Ganaste $${commission.toFixed(2)}! Comisión del ${commissionRate * 100}% por la primera recarga de tu referido ${username}.`,
                        });
                    }
                    console.log(`Comisión de ${commissionRate * 100}% asignada al distribuidor ${referrerId}`);
                }
            }
        }
        // ---------------------------------------------------------

        // ... (Resto del código: notificar usuario y admin)
        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('transactionApproved', {
                transactionId,
                amount: amountToAdd,
                message: `¡Tu recarga de $${amountToAdd.toFixed(2)} ha sido aprobada!`,
            });
        }

        io.emit('transactionsUpdated');
        io.emit('usersUpdated');

        res.status(200).json({ message: 'Transacción aprobada.' });
    } catch (error) {
        console.error('Approve transaction error:', error);
        res.status(500).json({ message: 'Error al aprobar.' });
    }
});

// 🔑 ENDPOINT: Rechazar una transacción
app.post('/admin/transaction/reject', async (req, res) => {
    const { userId, transactionId } = req.body;
    try {
        const userResult = await client.execute({
            sql: 'SELECT transactions_history FROM users WHERE id = ?',
            args: [userId]
        });
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        let history = JSON.parse(userResult.rows[0].transactions_history || '[]');
        let transactionFound = false;

        const updatedHistory = history.map(tx => {
            if (tx.id === transactionId && tx.status === 'Pendiente') {
                transactionFound = true;
                return { ...tx, status: 'Rechazada' };
            }
            return tx;
        });

        if (!transactionFound) return res.status(404).json({ message: 'Transacción no encontrada o ya procesada.' });

        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), userId]
        });

        io.emit('transactionsUpdated');

        res.status(200).json({ message: 'Transacción rechazada.' });
    } catch (error) {
        console.error('Reject transaction error:', error);
        res.status(500).json({ message: 'Error al rechazar la transacción.' });
    }
});


// --- Transaction Management Routes ---

// 🔑 NUEVO ENDPOINT: Registrar una nueva transacción
app.post('/transaction/record', async (req, res) => {
    const { userId, transaction } = req.body;

    if (!userId || !transaction) {
        return res.status(400).json({ message: 'ID de usuario y datos de transacción son requeridos.' });
    }

    try {
        // 1. Obtener el historial de transacciones actual
        const result = await client.execute({
            sql: 'SELECT transactions_history FROM users WHERE id = ?',
            args: [userId]
        });

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        // 2. Actualizar el historial
        const currentHistory = JSON.parse(result.rows[0].transactions_history || '[]');
        const updatedHistory = [transaction, ...currentHistory]; // Añadir al principio

        // 3. Guardar el historial actualizado en la DB
        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), userId]
        });

        // CRÍTICO: Emitir evento global para notificar al Admin
        io.emit('transactionsUpdated');

        res.status(200).json({ message: 'Transacción registrada exitosamente.' });

    } catch (error) {
        console.error('Transaction record error:', error);
        res.status(500).json({ message: 'Error interno del servidor al registrar la transacción.' });
    }
});

// 🔑 NUEVO ENDPOINT: Cancelar una transacción existente
app.post('/transaction/cancel', async (req, res) => {
    const { userId, transactionId } = req.body;

    if (!userId || !transactionId) {
        return res.status(400).json({ message: 'ID de usuario y ID de transacción son requeridos.' });
    }

    try {
        // 1. Obtener el historial actual
        const result = await client.execute({
            sql: 'SELECT transactions_history FROM users WHERE id = ?',
            args: [userId]
        });

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        let currentHistory = JSON.parse(result.rows[0].transactions_history || '[]');

        // 2. Buscar la transacción y verificar su estado
        const transactionToCancel = currentHistory.find(tx => tx.id === transactionId);

        if (!transactionToCancel) {
            return res.status(404).json({ message: 'Transacción no encontrada en el historial.' });
        }

        // CRÍTICO: Solo permitir cancelación si está Pendiente
        if (transactionToCancel.status !== 'Pendiente') {
            return res.status(400).json({ message: `La transacción ya está en estado: ${transactionToCancel.status}. No puede ser cancelada.` });
        }

        // 3. Actualizar el estado a 'Cancelada'
        const updatedHistory = currentHistory.map(tx => {
            if (tx.id === transactionId) {
                return { ...tx, status: 'Cancelada' }; // Cambiar estado
            }
            return tx;
        });

        // 4. Guardar el historial actualizado
        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), userId]
        });

        // NUEVO: Emitir evento global para actualizar tablas de Admin (ya que una pendiente fue cancelada)
        io.emit('transactionsUpdated');


        res.status(200).json({ message: 'Transacción cancelada exitosamente.' });

    } catch (error) {
        console.error('Transaction cancel error:', error);
        res.status(500).json({ message: 'Error interno del servidor al cancelar la transacción.' });
    }
});


// 🔑 ENDPOINT ACTUALIZADO: Aplicar para ser distribuidor (Dinámico)
app.post('/user/apply-supplier', async (req, res) => {
    const { userId, referralCode } = req.body;
    const numericUserId = parseInt(userId);
    const SUPPLIER_COST = 7.50; // Costo del rango

    if (!numericUserId || !referralCode) {
        return res.status(400).json({ message: 'Datos incompletos.' });
    }

    // Normalizar código
    const normalizedCode = referralCode.toUpperCase();
    let referrerId = null;

    try {
        // 1. Validar el código de referido
        if (normalizedCode === 'BLD231') {
            referrerId = null; // Código del sistema
        } else {
            const referrerResult = await client.execute({
                sql: "SELECT id FROM users WHERE referral_code = ?",
                args: [normalizedCode]
            });

            if (referrerResult.rows.length === 0) {
                return res.status(400).json({ message: 'Código de referido no existe.' });
            }
            referrerId = referrerResult.rows[0].id;

            if (referrerId === numericUserId) {
                return res.status(400).json({ message: 'No puedes usar tu propio código.' });
            }
        }

        // 2. Verificar Saldo del Usuario
        const userResult = await client.execute({
            sql: "SELECT balance, transactions_history, username FROM users WHERE id = ?",
            args: [numericUserId]
        });

        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const user = userResult.rows[0];
        const currentBalance = user.balance;

        if (currentBalance < SUPPLIER_COST) {
            return res.status(400).json({ message: `Saldo insuficiente. Necesitas $${SUPPLIER_COST.toFixed(2)}` });
        }

        // 3. Procesar el Pago (Restar saldo y agregar transacción)
        const newBalance = currentBalance - SUPPLIER_COST;
        const currentHistory = JSON.parse(user.transactions_history || '[]');

        const purchaseTx = {
            id: Date.now(),
            date: new Date().toLocaleDateString('es-PE'),
            description: 'Compra Rango Distribuidor',
            amount: SUPPLIER_COST,
            type: 'debit',
            status: 'Completada',
            details: {
                productName: 'Rango Distribuidor',
                platform: 'MeluStreaming',
                planType: 'Membresía',
                provider: 'Sistema',
                cost: SUPPLIER_COST,
                purchaseDate: new Date().toLocaleDateString('es-PE')
            }
        };

        const updatedHistory = [purchaseTx, ...currentHistory];

        // 4. Actualizar Usuario: Saldo, Historial y Estado Pendiente
        await client.execute({
            sql: "UPDATE users SET balance = ?, transactions_history = ?, role = 'Pending', is_approved = 0, referred_by_user_id = ? WHERE id = ?",
            args: [newBalance, JSON.stringify(updatedHistory), referrerId, numericUserId]
        });

        // Notificar cambios
        io.emit('pendingUsersUpdated'); // Al admin
        io.emit('usersUpdated'); // A la tabla de usuarios

        // Notificar al propio usuario (saldo actualizado)
        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('transactionApproved', {
                message: `¡Pago exitoso! Solicitud enviada.`,
            });
        }

        res.status(200).json({ message: 'Solicitud y pago procesados exitosamente.' });

    } catch (error) {
        console.error('Error applying for supplier:', error);
        res.status(500).json({ message: 'Error interno al procesar la solicitud.' });
    }
});

// 🔑 NUEVO ENDPOINT: Cancelar solicitud de distribuidor (Restaurar a Usuario)
app.post('/user/cancel-supplier-application', async (req, res) => {
    const { userId } = req.body;
    const numericUserId = parseInt(userId);

    if (!numericUserId) {
        return res.status(400).json({ message: 'ID de usuario requerido.' });
    }

    try {
        // Revertimos el rol a 'Usuario' y lo aprobamos automáticamente (is_approved = 1)
        // Esto lo sacará inmediatamente de la PendingUserTable
        await client.execute({
            sql: "UPDATE users SET role = 'Usuario', is_approved = 1 WHERE id = ?",
            args: [numericUserId]
        });

        // 🔥 CRÍTICO: Emitir evento para limpiar la tabla del admin en tiempo real
        io.emit('pendingUsersUpdated');

        res.status(200).json({ message: 'Solicitud cancelada correctamente.' });

    } catch (error) {
        console.error('Error cancelling supplier application:', error);
        res.status(500).json({ message: 'Error al cancelar la solicitud.' });
    }
});


// 🔑 ENDPOINT MODIFICADO: Deducir saldo y registrar pago de publicación (Simulación)
app.post('/user/deduct-balance-and-record-publication', async (req, res) => {
    // Recibe userId, newBalance (el saldo después de la deducción), y la transacción completa.
    const { userId, newBalance, transaction, productId, months } = req.body;
    const numericUserId = parseInt(userId);
    const numericNewBalance = parseFloat(newBalance);
    const numericMonths = parseInt(months);
    const numericProductId = parseInt(productId);

    if (!numericUserId || isNaN(numericNewBalance) || !transaction || isNaN(numericProductId) || isNaN(numericMonths) || numericMonths < 1) {
        return res.status(400).json({ message: 'Datos de pago de publicación incompletos o inválidos.' });
    }

    try {
        // 1. Obtener datos del usuario y del producto
        const userResult = await client.execute({
            sql: 'SELECT transactions_history FROM users WHERE id = ?',
            args: [numericUserId]
        });

        // Se necesitan más campos para esta lógica, pero si solo se usa para fecha de expiración, asumimos la base
        // Si el producto no se encuentra en la base, debería fallar.
        const productResult = await client.execute({
            sql: 'SELECT publication_end_date FROM products WHERE id = ?',
            args: [numericProductId]
        });
        
        if (userResult.rows.length === 0 || productResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario o Producto no encontrado.' });
        }
        
        const currentEndDateString = productResult.rows[0].publication_end_date;


        // 2. Determinar la fecha de inicio del nuevo periodo (LÓGICA DE RENOVACIÓN)
        let startDate = new Date();

        if (currentEndDateString) {
            const existingEndDate = new Date(currentEndDateString);
            const now = new Date();

            // Si la fecha de expiración existente está en el FUTURO (es válida),
            // el nuevo periodo empieza DESPUÉS de esa fecha.
            if (existingEndDate.getTime() > now.getTime()) {
                startDate = existingEndDate;
            }
            // Si está en el pasado o ahora, el nuevo periodo empieza desde AHORA (startDate sigue siendo new Date()).
        }

        // 3. Calcular la nueva fecha de finalización
        // Creamos un nuevo objeto Date para evitar modificar in-place la fecha de expiración si la usamos como base.
        let newEndDate = new Date(startDate.getTime());
        newEndDate.setMonth(newEndDate.getMonth() + numericMonths);

        // Formato DATETIME compatible con SQLite: YYYY-MM-DD HH:MM:SS
        const formattedEndDate = newEndDate.toISOString().replace('T', ' ').substring(0, 19);

        // 4. Actualizar Balance y Historial del Usuario (lógica existente)
        const currentHistory = JSON.parse(userResult.rows[0].transactions_history || '[]');
        const updatedHistory = [transaction, ...currentHistory];

        await client.execute({
            sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?',
            args: [numericNewBalance, JSON.stringify(updatedHistory), numericUserId]
        });

        // 5. ACTUALIZAR ESTADO DE PUBLICACIÓN DEL PRODUCTO con la nueva fecha
        await client.execute({
            sql: `UPDATE products SET 
                  is_published = 1, 
                  publication_end_date = ? 
                  WHERE id = ? AND creator_user_id = ?`,
            args: [formattedEndDate, numericProductId, numericUserId]
        });

        console.log(`Product ${numericProductId} published/renewed by user ${numericUserId} for ${numericMonths} months, until ${formattedEndDate}.`);

        // 6. Notificar a los clientes
        io.emit('transactionsUpdated');
        io.emit('usersUpdated');
        io.emit('productsUpdated');

        // 7. Devolver respuesta JSON esperada por el frontend
        res.status(200).json({
            message: 'Pago de publicación procesado exitosamente.',
            newBalance: numericNewBalance.toFixed(2),
        });

    } catch (error) {
        console.error('Publication payment API error:', error);
        res.status(500).json({ message: 'Error interno del servidor al procesar el pago de publicación.' });
    }
});
// 🔑 NUEVO ENDPOINT: Registrar nombre y teléfono del cliente final (POST-ENTREGA)

app.post('/user/delivery-confirmation', async (req, res) => {
    const { stockItemIds, clientName, clientPhone } = req.body;

    if (!stockItemIds || !Array.isArray(stockItemIds) || stockItemIds.length === 0 || !clientName || !clientPhone) {
        return res.status(400).json({ message: 'Datos de entrega incompletos o inválidos.' });
    }

    // Aseguramos que los IDs sean enteros y evitamos inyección
    const validIds = stockItemIds.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (validIds.length !== stockItemIds.length) {
        return res.status(400).json({ message: 'IDs de stock inválidos.' });
    }
    const idsString = validIds.join(',');

    try {
        // 1. Actualizar las filas de stock con el nombre y teléfono del cliente
        await client.execute({
            sql: `UPDATE product_stock SET client_name = ?, client_phone = ? WHERE id IN (${idsString})`,
            args: [clientName, clientPhone]
        });

        res.status(200).json({ message: 'Datos de cliente registrados exitosamente.' });
    } catch (error) {
        console.error('Delivery confirmation error:', error);
        res.status(500).json({ message: 'Error al registrar los datos del cliente.' });
    }
});

app.post('/user/update-client-delivery', async (req, res) => {
    const { stockId, clientName, clientPhone } = req.body;
    const numericStockId = parseInt(stockId);

    if (!numericStockId || !clientName || !clientPhone) {
        return res.status(400).json({ message: 'Datos de cliente incompletos o ID de stock inválido.' });
    }

    try {
        // Actualizamos la fila de stock con los nuevos datos del cliente
        await client.execute({
            sql: `UPDATE product_stock SET client_name = ?, client_phone = ? WHERE id = ?`,
            args: [clientName, clientPhone, numericStockId]
        });

        // Notificar al sistema para que refresque las tablas (Admin y Compras)
        io.emit('transactionsUpdated');

        res.status(200).json({ message: 'Datos del cliente actualizados exitosamente.' });
    } catch (error) {
        console.error('Update client delivery error:', error);
        res.status(500).json({ message: 'Error al actualizar los datos del cliente.' });
    }
});

// 🔑 ENDPOINT CRÍTICO MODIFICADO: Procesar Compra (Devuelve stockId)
// 🔑 ENDPOINT: Procesar Compra (Actualizado con enlace de transacción)
app.post('/user/purchase', async (req, res) => {
    const { userId, productName, amount, platform, type, provider, duration, terms, quantity = 1, delivery, finalPricePerUnit } = req.body;
    const numericUserId = parseInt(userId);
    const numericQty = parseInt(quantity);
    const numericAmount = parseFloat(amount);
    const numericFinalPricePerUnit = parseFloat(finalPricePerUnit);

    if (!numericUserId || !productName || isNaN(numericAmount)) return res.status(400).json({ message: 'Datos incompletos.' });

    try {
        // 1. Validaciones iniciales
        const userResult = await client.execute({ sql: 'SELECT balance, transactions_history, username, role FROM users WHERE id = ?', args: [numericUserId] });
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const user = userResult.rows[0];
        if (user.balance < numericAmount) return res.status(400).json({ message: 'Saldo insuficiente.' });

        const productResult = await client.execute({
            sql: 'SELECT id, stock, duration, delivery, creator_user_id, product_details, instructions, is_renewable, price_renewal_standard, price_renewal_premium FROM products WHERE name = ? AND platform = ? LIMIT 1',
            args: [productName, platform]
        });
        if (productResult.rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado.' });
        const product = productResult.rows[0];
        const productId = product.id;
        const providerId = product.creator_user_id;

        const isOrderRequest = (delivery === 'A pedido') || (product.delivery === 'A pedido');
        let credentialsList = [];

        // 2. Asignación de Stock
        const allStock = await client.execute({ sql: "SELECT id, data FROM product_stock WHERE product_id = ? AND is_sold = 0", args: [productId] });
        let collectedCount = 0;
        const updatesToExecute = [];
        
        for (const row of allStock.rows) {
            if (collectedCount >= numericQty) break;
            const data = JSON.parse(row.data);
            if (data.status === 'Sin publicar') continue;
            const availableInRow = parseInt(data.quantity) || 1;
            const needed = numericQty - collectedCount;

            if (availableInRow > needed) {
                const updatedData = { ...data, quantity: availableInRow - needed };
                updatesToExecute.push(client.execute({ sql: "UPDATE product_stock SET data = ? WHERE id = ?", args: [JSON.stringify(updatedData), row.id] }));
                for (let k = 0; k < needed; k++) {
                    const soldCopy = { ...data, quantity: 1, price_sold_per_unit: numericFinalPricePerUnit };
                    const insertRes = await client.execute({ sql: "INSERT INTO product_stock (product_id, provider_user_id, data, is_sold, sold_to_user_id, sold_at) VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)", args: [productId, providerId, JSON.stringify(soldCopy), numericUserId] });
                    credentialsList.push({ stockId: insertRes.lastInsertRowid.toString(), productId, ...soldCopy });
                }
                collectedCount += needed;
            } else {
                const soldData = { ...data, price_sold_per_unit: numericFinalPricePerUnit };
                updatesToExecute.push(client.execute({ sql: "UPDATE product_stock SET is_sold = 1, sold_to_user_id = ?, sold_at = CURRENT_TIMESTAMP, data = ? WHERE id = ?", args: [numericUserId, JSON.stringify(soldData), row.id] }));
                credentialsList.push({ stockId: row.id, productId, ...soldData });
                collectedCount += availableInRow;
            }
        }

        if (collectedCount < numericQty) return res.status(409).json({ message: `Stock insuficiente.` });
        await Promise.all(updatesToExecute);
        await client.execute({ sql: 'UPDATE products SET stock = stock - ? WHERE id = ?', args: [numericQty, productId] });

        // 3. Transacción Comprador (DÉBITO)
        const buyerNewBalance = user.balance - numericAmount;
        const purchaseDate = new Date();
        const transactionId = `#ORD-${Math.random().toString(36).substring(2, 8).toUpperCase()}`; // ID ÚNICO DEL COMPRADOR

        const durationMatch = product.duration.match(/\d+/);
        const durationDays = durationMatch ? parseInt(durationMatch[0]) : 30;
        const expDate = new Date(purchaseDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

        const newBuyerTransaction = {
            id: transactionId,
            date: purchaseDate.toLocaleDateString('es-PE'),
            description: `Compra de ${productName} (${numericQty}x)`,
            amount: numericAmount,
            type: 'debit',
            status: 'Completada',
            details: {
                productName, platform, planType: type, provider: product.provider, duration: product.duration, terms, cost: numericAmount,
                fullCredentials: credentialsList, purchaseDate: new Date().toLocaleDateString('es-PE'), expirationDate: expDate.toLocaleDateString('es-PE'),
                delivery: isOrderRequest ? 'A pedido' : 'Autoentrega', quantity: numericQty, productDetails: product.product_details, instructions: product.instructions,
                isRenewable: product.is_renewable === 1, priceRenewalStandard: product.price_renewal_standard || 0, priceRenewalPremium: product.price_renewal_premium || 0,
                priceSoldPerUnit: numericFinalPricePerUnit, priceSoldTotal: numericAmount
            }
        };
        
        const currentBuyerHistory = JSON.parse(user.transactions_history || '[]');
        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [buyerNewBalance, JSON.stringify([newBuyerTransaction, ...currentBuyerHistory]), numericUserId] });

        // 4. Transacción Proveedor
        const providerResult = await client.execute({ sql: 'SELECT balance, transactions_history, username, phone FROM users WHERE id = ?', args: [providerId] });
        const providerData = providerResult.rows[0];
        const providerNewBalance = providerData.balance + numericAmount;
        
        const newProviderTransaction = {
            id: Date.now(),
            date: purchaseDate.toLocaleDateString('es-PE'),
            description: `Venta: ${productName} (${user.username})`,
            amount: numericAmount,
            type: 'credit',
            status: 'Completada',
            isCommission: true, 
            sourceUser: user.username,
            originalAmount: numericAmount,
            buyerUserId: numericUserId, 
            buyerTransactionId: transactionId 
        };
        
        const currentProviderHistory = JSON.parse(providerData.transactions_history || '[]');
        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ?, phone = ? WHERE id = ?', args: [providerNewBalance, JSON.stringify([newProviderTransaction, ...currentProviderHistory]), providerData.phone || null, providerId] });

        if (isOrderRequest) {
            await client.execute({ sql: `INSERT INTO orders (purchase_id, buyer_user_id, provider_user_id, product_id, quantity, total_price, status) VALUES (?, ?, ?, ?, ?, ?, 'Pending')`, args: [transactionId, numericUserId, providerId, productId, numericQty, numericAmount] });
            io.emit('ordersUpdated');
        }

        io.emit('transactionsUpdated');
        io.emit('productsUpdated');
        io.emit('usersUpdated');

        const targetSocketId = userSocketMap.get(numericUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('transactionApproved', { transactionId: newBuyerTransaction.id, amount: numericAmount, message: `¡Tu compra de ${productName} ha sido completada!` });
        }

        // 🟢 FIX: Enviamos las fechas en la respuesta raíz para que el modal de entrega las reciba
        res.status(200).json({ 
            message: 'Compra realizada.', 
            newBalance: buyerNewBalance.toFixed(2), 
            credentials: credentialsList,
            purchaseDate: new Date().toLocaleDateString('es-PE'),
            expirationDate: expDate.toLocaleDateString('es-PE') 
        });
    } catch (error) {
        console.error('Purchase error:', error);
        res.status(500).json({ message: 'Error interno.' });
    }
});


// 🔑 NUEVO ENDPOINT: Comprar/Renovar Membresía Premium
app.post('/user/upgrade-to-premium', async (req, res) => {
    const { userId, amount, months } = req.body;
    const numericUserId = parseInt(userId);
    const numericAmount = parseFloat(amount);
    const numericMonths = parseInt(months);

    if (!numericUserId || isNaN(numericAmount) || isNaN(numericMonths) || numericMonths < 1) {
        return res.status(400).json({ message: 'Datos inválidos.' });
    }

    try {
        // 1. Obtener usuario
        const userResult = await client.execute({
            sql: 'SELECT balance, role, premium_expires_at, transactions_history FROM users WHERE id = ?',
            args: [numericUserId]
        });

        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const user = userResult.rows[0];

        // 2. Verificar Saldo
        if (user.balance < numericAmount) {
            return res.status(400).json({ message: 'Saldo insuficiente para adquirir Premium.' });
        }

        // 3. Calcular Nueva Fecha de Expiración (Igual que antes)
        let newExpirationDate;
        const now = new Date();

        if (user.role === 'Distribuidor Premium' && user.premium_expires_at) {
            const currentExpiry = new Date(user.premium_expires_at);
            if (currentExpiry > now) {
                newExpirationDate = new Date(currentExpiry);
                newExpirationDate.setMonth(newExpirationDate.getMonth() + numericMonths);
            } else {
                newExpirationDate = new Date();
                newExpirationDate.setMonth(newExpirationDate.getMonth() + numericMonths);
            }
        } else {
            newExpirationDate = new Date();
            newExpirationDate.setMonth(newExpirationDate.getMonth() + numericMonths);
        }

        const formattedExpiration = newExpirationDate.toISOString().replace('T', ' ').substring(0, 19);

        // 4. Registrar Transacción (CON DATOS COMPLETOS)
        const newBalance = user.balance - numericAmount;

        const transaction = {
            id: Date.now(), // ID numérico simple
            date: new Date().toLocaleDateString('es-PE'),
            description: `Compra Membresía Distribuidor Premium (${numericMonths} mes${numericMonths > 1 ? 'es' : ''})`,
            amount: numericAmount,
            type: 'debit',
            status: 'Completada',
            details: {
                type: 'premium_upgrade',
                productName: 'Membresía Distribuidor Premium', // 🟢 Agregado para la tabla
                platform: 'MeluStreaming', // 🟢 Agregado
                planType: `${numericMonths} Mes(es)`, // 🟢 Agregado
                provider: 'Sistema', // 🟢 Agregado
                terms: 'Acceso a precios especiales y comisiones.', // 🟢 Agregado
                months: numericMonths,
                expirationDate: formattedExpiration,
                purchaseDate: new Date().toLocaleDateString('es-PE'), // 🟢 Agregado
                cost: numericAmount // 🟢 CRÍTICO: Agregado el costo para que no falle el .toFixed(2)
            }
        };

        const currentHistory = JSON.parse(user.transactions_history || '[]');
        const updatedHistory = [transaction, ...currentHistory];

        // 5. Actualizar Usuario en DB
        await client.execute({
            sql: `UPDATE users SET 
                  balance = ?, 
                  role = 'Distribuidor Premium', 
                  premium_expires_at = ?, 
                  transactions_history = ? 
                  WHERE id = ?`,
            args: [newBalance, formattedExpiration, JSON.stringify(updatedHistory), numericUserId]
        });

        // 6. Notificar
        io.emit('usersUpdated');

        res.status(200).json({
            message: '¡Membresía Premium activada!',
            newBalance: newBalance,
            newRole: 'Distribuidor Premium',
            expiresAt: formattedExpiration
        });

    } catch (error) {
        console.error('Premium upgrade error:', error);
        res.status(500).json({ message: 'Error al procesar la compra Premium.' });
    }
});

// 🔑 ENDPOINT: Estadísticas del Dashboard Admin
app.get('/admin/stats', async (req, res) => {
    try {
        // Obtenemos rol e historial de todos los usuarios
        const result = await client.execute('SELECT role, transactions_history FROM users');
        const users = result.rows;

        // 1. Estadísticas de Usuarios
        const totalUsers = users.length;
        const rolesCount = {
            'Usuario': 0,
            'distribuidor': 0,
            'Distribuidor Premium': 0,
            'proveedor': 0,
            'Admin': 0
        };

        // 2. Estadísticas de Recargas (Dinero)
        let recharges = {
            day: 0,
            week: 0,
            month: 0,
            year: 0,
            total: 0
        };

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        const currentDay = now.getDay(); // 0 (Domingo) - 6 (Sábado)
        const diff = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1); // Ajuste al Lunes
        const startOfWeek = new Date(now.setDate(diff));
        startOfWeek.setHours(0, 0, 0, 0);
        const startOfWeekTime = startOfWeek.getTime();

        // Reset para mes/año
        const nowForMonth = new Date();
        const startOfMonth = new Date(nowForMonth.getFullYear(), nowForMonth.getMonth(), 1).getTime();
        const startOfYear = new Date(nowForMonth.getFullYear(), 0, 1).getTime();

        users.forEach(user => {
            // Conteo de Roles
            const r = user.role || 'Usuario';
            if (rolesCount[r] !== undefined) {
                rolesCount[r]++;
            } else {
                rolesCount[r] = (rolesCount[r] || 0) + 1;
            }

            // Cálculo de Recargas (Solo 'credit' y 'Completada')
            const history = JSON.parse(user.transactions_history || '[]');
            history.forEach(tx => {
                if (tx.type === 'credit' && tx.status === 'Completada') {
                    const amount = parseFloat(tx.amount);
                    // Usamos tx.id como timestamp
                    const txTime = typeof tx.id === 'number' ? tx.id : 0;

                    if (txTime > 0) {
                        recharges.total += amount;
                        if (txTime >= startOfYear) recharges.year += amount;
                        if (txTime >= startOfMonth) recharges.month += amount;
                        if (txTime >= startOfWeekTime) recharges.week += amount;
                        if (txTime >= startOfDay) recharges.day += amount;
                    }
                }
            });
        });

        res.status(200).json({
            totalUsers,
            rolesCount,
            recharges
        });

    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ message: 'Error al calcular estadísticas.' });
    }
});

// 🔑 ENDPOINT: Obtener productos para gestión ADMIN (Incluye etiquetas)
app.get('/admin/products-management', async (req, res) => {
    try {
        const result = await client.execute(`SELECT * FROM products ORDER BY created_at DESC`);

        const products = result.rows.map(p => ({
            id: p.id,
            name: p.name,
            platform: p.platform,
            stock: p.stock || 0,
            priceStandard: p.price_standard,
            imageUrl: p.image_url,
            isBestSeller: p.is_best_seller === 1,
            isOffer: p.is_offer === 1,
            isTrending: p.is_trending === 1, // Carrusel
            isPublished: p.is_published === 1
        }));

        res.status(200).json(products);
    } catch (error) {
        console.error('Admin products fetch error:', error);
        res.status(500).json({ message: 'Error al obtener productos.' });
    }
});

// 🔑 ENDPOINT: Actualizar etiquetas de un producto (Admin)
app.post('/admin/product/update-tags', async (req, res) => {
    const { productId, tags } = req.body; // tags: { isBestSeller, isOffer, isTrending }

    if (!productId || !tags) return res.status(400).json({ message: 'Datos incompletos.' });

    try {
        // Si se activa 'isTrending', verificar que no haya más de 4
        if (tags.isTrending) {
            const trendingCount = await client.execute("SELECT COUNT(*) as count FROM products WHERE is_trending = 1 AND id != ?", [productId]);
            if (trendingCount.rows[0].count >= 4) {
                return res.status(400).json({ message: 'Límite alcanzado: Máximo 4 productos en el Carrusel.' });
            }
        }

        await client.execute({
            sql: `UPDATE products SET is_best_seller = ?, is_offer = ?, is_trending = ? WHERE id = ?`,
            args: [
                tags.isBestSeller ? 1 : 0,
                tags.isOffer ? 1 : 0,
                tags.isTrending ? 1 : 0,
                productId
            ]
        });

        io.emit('productsUpdated'); // Actualizar Admin y Home
        res.status(200).json({ message: 'Etiquetas actualizadas.' });

    } catch (error) {
        console.error('Update tags error:', error);
        res.status(500).json({ message: 'Error al actualizar etiquetas.' });
    }
});

// 🔑 ENDPOINT: Eliminar producto (Admin)
app.post('/admin/product/delete', async (req, res) => {
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: 'ID requerido.' });

    try {
        // 🟢 1. Eliminar pedidos asociados (CRÍTICO para productos "A pedido")
        // Esto soluciona el error 500 por restricción de llave foránea en la tabla 'orders'
        await client.execute({ sql: 'DELETE FROM orders WHERE product_id = ?', args: [productId] });

        // 2. Eliminar stock asociado
        await client.execute({ sql: 'DELETE FROM product_stock WHERE product_id = ?', args: [productId] });

        // 3. Eliminar producto
        await client.execute({ sql: 'DELETE FROM products WHERE id = ?', args: [productId] });

        io.emit('productsUpdated');
        res.status(200).json({ message: 'Producto eliminado correctamente.' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ message: 'Error al eliminar producto.' });
    }
});

// 🔑 ENDPOINT: Obtener productos "Tendencia" para el Carrusel (Público)
// 🔑 ENDPOINT ACTUALIZADO: Obtener productos "Tendencia" con TODOS los detalles
app.get('/products/trending-carousel', async (req, res) => {
    try {
        // Seleccionamos los productos marcados como trending
        const result = await client.execute({
            sql: `SELECT * FROM products WHERE is_trending = 1 LIMIT 4`,
            args: []
        });

        // Mapeamos TODOS los campos necesarios para el ProductDetailModal
        const products = result.rows.map(p => ({
            id: p.id,
            name: p.name,
            platform: p.platform,
            description: p.description,
            isRenewable: p.is_renewable === 1,
            delivery: p.delivery,
            duration: p.duration,
            type: p.type,
            priceStandard: p.price_standard || 0,
            pricePremium: p.price_premium || 0,
            priceRenewalStandard: p.price_renewal_standard || 0,
            priceRenewalPremium: p.price_renewal_premium || 0,
            imageUrl: p.image_url,
            images: JSON.parse(p.images || '[]'),
            stock: p.stock || 0,
            provider: p.provider,
            iconName: p.icon_name,
            creatorUserId: p.creator_user_id,
            isPublished: p.is_published === 1,
            publicationEndDate: p.publication_end_date,
            isBestSeller: p.is_best_seller === 1,
            isOffer: p.is_offer === 1,
            isTrending: p.is_trending === 1
        }));

        res.status(200).json(products);
    } catch (error) {
        console.error('Fetch trending error:', error);
        res.status(500).json({ message: 'Error al cargar tendencias.' });
    }
});

app.get('/supplier/sales/:providerId', async (req, res) => {
    const { providerId } = req.params;

    try {
        const result = await client.execute({
            sql: `
                SELECT 
                    p.id as product_id,
                    u.id as buyer_id,
                    p.name as product_name,
                    p.platform,
                    p.duration, -- 🟢 CRÍTICO: Añadido para calcular expiración
                    p.price_standard,
                    p.price_premium,
                    u.username as buyer_name,
                    u.phone as buyer_phone,
                    u.role as buyer_role,
                    COUNT(ps.id) as quantity,
                    ps.sold_at,
                    MAX(ps.data) as first_data_item 
                FROM product_stock ps
                JOIN products p ON ps.product_id = p.id
                JOIN users u ON ps.sold_to_user_id = u.id
                WHERE ps.provider_user_id = ? AND ps.is_sold = 1
                GROUP BY ps.sold_at, ps.sold_to_user_id, ps.product_id
                ORDER BY ps.sold_at DESC
            `,
            args: [providerId]
        });

        const sales = result.rows.map(row => {
            let unitPrice = row.price_standard;

            // Intentar obtener datos del stock (credenciales y precio real)
            let stockData = {};
            try {
                stockData = JSON.parse(row.first_data_item);
                if (stockData.price_sold_per_unit) {
                    const storedPrice = parseFloat(stockData.price_sold_per_unit);
                    if (!isNaN(storedPrice) && storedPrice > 0) unitPrice = storedPrice;
                } else {
                    // Fallback lógica antigua
                    if (row.buyer_role === 'distribuidor' || row.buyer_role === 'proveedor' || row.buyer_role === 'Admin') {
                        unitPrice = row.price_premium;
                    } else if (row.buyer_role === 'Distribuidor Premium') {
                        unitPrice = row.price_premium * 0.9;
                    }
                }
            } catch (e) {}
            
            return {
                productId: row.product_id,
                buyerId: row.buyer_id,
                productName: row.product_name,
                platform: row.platform,
                duration: row.duration, // 🟢 Enviamos duración
                buyerName: row.buyer_name,
                buyerPhone: row.buyer_phone || '',
                buyerRole: row.buyer_role,
                quantity: row.quantity,
                total: unitPrice * row.quantity,
                unitPrice: unitPrice, 
                fullDate: row.sold_at,
                // 🟢 Enviamos credenciales para la tabla de expirados
                credentials: {
                    username: stockData.username || 'N/A',
                    password: stockData.password || 'N/A'
                },
                displayDate: new Date(row.sold_at).toLocaleDateString('es-PE', {
                    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })
            };
        });

        res.status(200).json(sales);

    } catch (error) {
        console.error('Fetch supplier sales error:', error);
        res.status(500).json({ message: 'Error al obtener las ventas.' });
    }
});

// 🔑 NUEVO ENDPOINT: Obtener pedidos "A pedido" de un proveedor
app.get('/supplier/orders/:providerId', async (req, res) => {
    const { providerId } = req.params;

    try {
        const result = await client.execute({
            sql: `
                SELECT 
                    o.id,
                    o.purchase_id,
                    o.quantity,
                    o.created_at,
                    p.name as product_name,
                    u.username as buyer_name,
                    u.role as buyer_role,
                    u.phone as buyer_phone
                FROM orders o
                JOIN products p ON o.product_id = p.id
                JOIN users u ON o.buyer_user_id = u.id
                WHERE o.provider_user_id = ?
                ORDER BY o.created_at DESC
            `,
            args: [providerId]
        });

        const orders = result.rows.map(row => ({
            id: row.id,
            purchaseId: row.purchase_id,
            productName: row.product_name,
            buyerName: row.buyer_name,
            buyerRole: row.buyer_role,
            buyerPhone: row.buyer_phone,
            quantity: row.quantity,
            date: new Date(row.created_at).toLocaleDateString('es-PE', {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            })
        }));

        res.status(200).json(orders);

    } catch (error) {
        console.error('Fetch supplier orders error:', error);
        res.status(500).json({ message: 'Error al obtener los pedidos.' });
    }
});

// 🔑 NUEVO ENDPOINT: Configurar productos del Carrusel (Bulk Update)
app.post('/admin/products/set-carousel', async (req, res) => {
    const { productIds } = req.body; // Array de IDs [1, 2, 3]

    if (!Array.isArray(productIds)) {
        return res.status(400).json({ message: 'Formato de datos inválido.' });
    }
    if (productIds.length > 4) {
        return res.status(400).json({ message: 'Máximo 4 productos permitidos en el carrusel.' });
    }

    try {
        // 1. Transacción: Primero quitamos el flag 'is_trending' a TODOS
        await client.execute("UPDATE products SET is_trending = 0");

        // 2. Si hay IDs seleccionados, les ponemos el flag
        if (productIds.length > 0) {
            // Construimos placeholders dinámicos (?, ?, ?)
            const placeholders = productIds.map(() => '?').join(',');

            await client.execute({
                sql: `UPDATE products SET is_trending = 1 WHERE id IN (${placeholders})`,
                args: productIds
            });
        }

        // 3. Notificar cambios
        io.emit('productsUpdated');

        res.status(200).json({ message: 'Carrusel actualizado exitosamente.' });

    } catch (error) {
        console.error('Set carousel error:', error);
        res.status(500).json({ message: 'Error al actualizar el carrusel.' });
    }
});

// 🔑 SECCIÓN DE INVENTARIO (STOCK DETALLADO)

// 1. Obtener todo el inventario de un proveedor (Agrupado por producto en el frontend)
app.get('/supplier/inventory/:providerId', async (req, res) => {
    const { providerId } = req.params;
    try {
        // Obtenemos todo el stock unido con información del producto
        const result = await client.execute({
            sql: `
                SELECT 
                    ps.id as stock_id,
                    ps.data,
                    ps.is_sold,
                    ps.sold_at,
                    p.id as product_id,
                    p.name as product_name,
                    p.platform,
                    p.is_published,
                    p.publication_end_date
                FROM product_stock ps
                JOIN products p ON ps.product_id = p.id
                WHERE ps.provider_user_id = ?
                ORDER BY p.name, ps.created_at DESC
            `,
            args: [providerId]
        });

        const inventory = result.rows.map(row => ({
            id: row.stock_id,
            productId: row.product_id,
            productName: row.product_name,
            platform: row.platform,
            data: JSON.parse(row.data),
            isSold: row.is_sold === 1,
            soldAt: row.sold_at,
            isPublished: row.is_published === 1,
            publicationEndDate: row.publication_end_date
        }));

        res.status(200).json(inventory);
    } catch (error) {
        console.error('Fetch inventory error:', error);
        res.status(500).json({ message: 'Error al obtener el inventario.' });
    }
});

// 2. Añadir stock a un producto existente
app.post('/supplier/stock/add', async (req, res) => {
    const { productId, providerId, items } = req.body;

    if (!productId || !providerId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'Datos inválidos.' });
    }

    try {
        for (const item of items) {
            let uniqueCode;
            let isUnique = false;
            let attempts = 0;

            while (!isUnique && attempts < 10) {
                uniqueCode = generateUniqueStockCode();
                const check = await client.execute({ sql: "SELECT id FROM product_stock WHERE data LIKE ?", args: [`%${uniqueCode}%`] });
                if (check.rows.length === 0) isUnique = true;
                attempts++;
            }

            const finalItemData = {
                ...item,
                quantity: parseInt(item.quantity) || 1,
                uniqueCode: uniqueCode,
                status: 'Sin publicar', // 🔒 ESTADO INICIAL
                addedAt: new Date().toISOString()
            };

            await client.execute({
                sql: `INSERT INTO product_stock (product_id, provider_user_id, data, is_sold) VALUES (?, ?, ?, 0)`,
                args: [productId, providerId, JSON.stringify(finalItemData)]
            });
        }

        // Recalculamos (Como están "Sin publicar", el stock visible NO aumentará)
        await updateProductStock(productId);

        io.emit('productsUpdated');
        res.status(200).json({ message: 'Stock añadido (Pendiente de publicar).' });

    } catch (error) {
        console.error('Add stock error:', error);
        res.status(500).json({ message: 'Error al añadir stock.' });
    }
});

// 3. Editar un ítem de stock específico (Credenciales)
app.put('/supplier/stock/:stockId', async (req, res) => {
    const { stockId } = req.params;
    const { data } = req.body; // Nuevo objeto JSON de credenciales

    try {
        await client.execute({
            sql: "UPDATE product_stock SET data = ? WHERE id = ?",
            args: [JSON.stringify(data), stockId]
        });

        // 🔥 CRÍTICO: Notificar cambio en tiempo real
        io.emit('productsUpdated');
        
        res.status(200).json({ message: 'Ítem actualizado.' });
    } catch (error) {
        console.error('Update stock item error:', error);
        res.status(500).json({ message: 'Error al actualizar el ítem.' });
    }
});

app.post('/supplier/stock/publish', async (req, res) => {
    const { stockId } = req.body;
    if (!stockId) return res.status(400).json({ message: 'ID requerido.' });

    try {
        const result = await client.execute({ sql: "SELECT id, product_id, data FROM product_stock WHERE id = ?", args: [stockId] });
        if (result.rows.length === 0) return res.status(404).json({ message: 'Ítem no encontrado.' });

        const row = result.rows[0];
        const data = JSON.parse(row.data);

        data.status = 'Publicado'; // 🟢 CAMBIO DE ESTADO

        await client.execute({
            sql: "UPDATE product_stock SET data = ? WHERE id = ?",
            args: [JSON.stringify(data), stockId]
        });

        // Recalcular (Ahora SÍ se sumará este ítem al total)
        await updateProductStock(row.product_id);

        io.emit('productsUpdated');
        res.status(200).json({ message: 'Stock publicado.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al publicar.' });
    }
});

// 4. Eliminar un ítem de stock específico
app.delete('/supplier/stock/:stockId', async (req, res) => {
    const { stockId } = req.params;
    try {
        const stockItem = await client.execute({ sql: "SELECT product_id FROM product_stock WHERE id = ?", args: [stockId] });
        if (stockItem.rows.length === 0) return res.status(404).json({ message: 'Ítem no encontrado.' });
        
        const { product_id } = stockItem.rows[0];

        await client.execute({ sql: "DELETE FROM product_stock WHERE id = ?", args: [stockId] });
        
        // Actualizar contador
        await updateProductStock(product_id);

        io.emit('productsUpdated');
        res.status(200).json({ message: 'Ítem eliminado.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar.' });
    }
});

app.post('/supplier/handle-support', async (req, res) => {
    const { purchaseId, action } = req.body; // action: 'complete' | 'refund'

    if (!purchaseId || !action) {
        return res.status(400).json({ message: 'ID de compra y acción requeridos.' });
    }

    try {
        // 1. Encontrar la transacción en el historial de TODOS los usuarios
        const allUsersResult = await client.execute('SELECT id, transactions_history FROM users');
        let targetUserId = null;
        let targetTx = null;
        let userHistory = null;
        
        for (const user of allUsersResult.rows) {
            const history = JSON.parse(user.transactions_history || '[]');
            targetTx = history.find(tx => tx.id === purchaseId && tx.status === 'Soporte');
            if (targetTx) {
                targetUserId = user.id;
                userHistory = history;
                break;
            }
        }

        if (!targetUserId || !targetTx) {
            return res.status(404).json({ message: 'Transacción en soporte no encontrada.' });
        }

        let newStatus = 'Completada';
        let newBalance = null;
        let refundTx = null;

        const updateTransaction = (tx) => {
            if (tx.id === purchaseId) {
                return { 
                    ...tx, 
                    status: newStatus,
                    details: {
                        ...tx.details,
                        supportMessage: null, // Limpiar mensaje de soporte al resolver
                        supportDate: null,
                    }
                };
            }
            return tx;
        };

        // 2. Realizar la acción específica
        if (action === 'refund') {
            const totalAmountPaid = targetTx.amount; // Monto original de la compra
            const purchaseDateStr = targetTx.details.purchaseDate;
            const durationStr = targetTx.details.duration; // Ej: "30 Días"

            // --- 🟢 LÓGICA DE REEMBOLSO PROPORCIONAL POR DÍA ---
            
            // a. Extraer la duración en días (ej: "30 Días" -> 30)
            const durationMatch = durationStr ? durationStr.match(/(\d+)\s+Días/) : null;
            const totalDays = durationMatch ? parseInt(durationMatch[1], 16) : 30;
            
            // Si no se pudo obtener la duración, asumimos 30 días
            const safeTotalDays = Math.max(1, totalDays); 

            // Convertir la fecha de compra a objeto Date (asumiendo formato dd/mm/yyyy de toLocaleDateString)
            const parts = purchaseDateStr.split('/').map(p => p.trim());
            const [day, month, year] = parts.map(Number);
            // Meses en JS son 0-indexados
            const purchasedDate = new Date(year, month - 1, day); 

            const today = new Date();

            // Calcular días transcurridos
            const oneDay = 1000 * 60 * 60 * 24;
            const diffTime = today.getTime() - purchasedDate.getTime();
            
            // Redondeamos hacia abajo los días USADOS para evitar reembolsar el día actual
            const daysUsed = Math.floor(diffTime / oneDay); 
            
            // Días restantes (mínimo 0)
            const daysRemaining = Math.max(0, safeTotalDays - daysUsed);
            
            // Costo diario
            const costPerDay = totalAmountPaid / safeTotalDays;
            
            // Monto de reembolso (usando solo 2 decimales y redondeando)
            let amountToRefund = daysRemaining * costPerDay;
            amountToRefund = parseFloat(amountToRefund.toFixed(2)); // Redondeo a 2 decimales
            
            console.log(`Reembolso: Total pagado: $${totalAmountPaid.toFixed(2)}. Días totales: ${safeTotalDays}. Días usados: ${daysUsed}. Días restantes: ${daysRemaining}. Monto a devolver: $${amountToRefund.toFixed(2)}.`);

            // Si el monto a devolver es 0, no se procede
            if (amountToRefund <= 0) {
                 return res.status(400).json({ message: `No hay monto para devolver. Días restantes: ${daysRemaining}.` });
            }
            
            // b. Calcular nuevo saldo del cliente
            const userResult = await client.execute({ sql: 'SELECT balance FROM users WHERE id = ?', args: [targetUserId] });
            const currentBalance = userResult.rows[0].balance;
            newBalance = parseFloat((currentBalance + amountToRefund).toFixed(2));
            newStatus = 'Devuelto';

            // c. Generar transacción de reembolso
            refundTx = {
                id: Date.now(),
                date: new Date().toLocaleDateString('es-PE'),
                description: `Reembolso (${daysRemaining} días): ${targetTx.details.productName}`,
                amount: amountToRefund,
                type: 'credit',
                status: 'Completada'
            };
            
            // d. Devolver stock (Solo si no fue "A pedido" y tiene credenciales)
            if (targetTx.details.fullCredentials && targetTx.details.fullCredentials.length > 0 && targetTx.details.delivery !== 'A pedido') {
                const stockIds = targetTx.details.fullCredentials.map(c => c.stockId).filter(id => id);
                if (stockIds.length > 0) {
                    const idsString = stockIds.join(',');
                    // Restaurar is_sold a 0
                    await client.execute({
                        sql: `UPDATE product_stock SET is_sold = 0, sold_to_user_id = NULL, sold_at = NULL, client_name = NULL, client_phone = NULL WHERE id IN (${idsString})`,
                        args: []
                    });
                    
                    // Aumentar stock del producto
                    const prodRes = await client.execute({ sql: 'SELECT id FROM products WHERE name = ? LIMIT 1', args: [targetTx.details.productName] });
                    const refundProductId = prodRes.rows[0]?.id;

                    if (refundProductId) {
                         await client.execute({ sql: `UPDATE products SET stock = stock + ? WHERE id = ?`, args: [targetTx.details.fullCredentials.length, refundProductId] });
                    }
                }
            }
            // --- 
        }
        
        // 3. Actualizar el historial del usuario (y saldo si hay reembolso)
        const updatedHistory = userHistory.map(updateTransaction);
        if (refundTx) {
            updatedHistory.unshift(refundTx);
        }

        const updates = ['transactions_history = ?'];
        const args = [JSON.stringify(updatedHistory)];

        if (newBalance !== null) {
             updates.push('balance = ?');
             args.push(newBalance);
        }
        args.push(targetUserId);

        await client.execute({ 
            sql: `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, 
            args: args
        });

        // 4. Notificar a todos
        io.emit('transactionsUpdated'); 
        io.emit('productsUpdated'); 

        res.status(200).json({ message: `Orden ${purchaseId} marcada como ${newStatus}.`, newStatus });

    } catch (error) {
        console.error('Handle support error:', error);
        res.status(500).json({ message: 'Error interno al manejar la solicitud de soporte.', details: error.message });
    }
});

app.post('/admin/user/delete', async (req, res) => {
    const { userId } = req.body;
    const numericUserId = parseInt(userId);

    if (!numericUserId) {
        return res.status(400).json({ message: 'ID de usuario requerido.' });
    }

    try {
        // 1. Verificar si es Admin para bloquear la eliminación
        const userResult = await client.execute({ sql: 'SELECT role FROM users WHERE id = ?', args: [numericUserId] });
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        if (userResult.rows[0].role === 'Admin') {
            return res.status(403).json({ message: 'No puedes eliminar la cuenta de Administrador.' });
        }

        // 2. Eliminar registros asociados (CRÍTICO para evitar errores de llave foránea)
        
        // a. Eliminar stock asociado
        await client.execute({ sql: 'DELETE FROM product_stock WHERE provider_user_id = ?', args: [numericUserId] });
        
        // b. Eliminar órdenes (donde es comprador o proveedor)
        await client.execute({ sql: 'DELETE FROM orders WHERE buyer_user_id = ? OR provider_user_id = ?', args: [numericUserId, numericUserId] });
        
        // c. Eliminar productos creados por este usuario
        await client.execute({ sql: 'DELETE FROM products WHERE creator_user_id = ?', args: [numericUserId] });
        
        // d. Eliminar retiros (withdrawals)
        await client.execute({ sql: 'DELETE FROM withdrawals WHERE user_id = ?', args: [numericUserId] });
        
        // 3. Eliminar el usuario
        await client.execute({
            sql: 'DELETE FROM users WHERE id = ?',
            args: [numericUserId]
        });

        io.emit('usersUpdated');

        res.status(200).json({ message: 'Cuenta eliminada permanentemente.' });

    } catch (error) {
        console.error('Admin delete user error:', error);
        res.status(500).json({ message: 'Error interno al eliminar la cuenta.', details: error.message });
    }
});

// 🟢 ENDPOINT: Procesar Reembolso Proporcional EXACTO
app.post('/supplier/refund/proportional', async (req, res) => {
    const { buyerUserId, buyerTransactionId, amountToRefund, providerId } = req.body;
    const numericAmount = parseFloat(amountToRefund);
    const numericProviderId = parseInt(providerId);
    const numericBuyerId = parseInt(buyerUserId);

    // Validación estricta de datos necesarios
    if (!buyerUserId || !buyerTransactionId || isNaN(numericAmount) || numericAmount <= 0 || !numericProviderId) {
        return res.status(400).json({ message: 'Datos de reembolso inválidos o incompletos. (Falta ID comprador o Transacción)' });
    }

    try {
        // 1. Obtener Comprador Directamente
        const buyerRes = await client.execute({ sql: 'SELECT balance, transactions_history, username FROM users WHERE id = ?', args: [numericBuyerId] });
        if (buyerRes.rows.length === 0) return res.status(404).json({ message: 'Comprador original no encontrado.' });
        const buyer = buyerRes.rows[0];
        const buyerHistory = JSON.parse(buyer.transactions_history || '[]');

        // 2. Encontrar la transacción exacta en el historial del comprador
        // Usamos String() para comparar por si uno es número y otro string
        const targetTxIndex = buyerHistory.findIndex(tx => String(tx.id) === String(buyerTransactionId) && tx.type === 'debit');
        
        if (targetTxIndex === -1) {
            return res.status(404).json({ message: 'La transacción no existe en el historial del comprador (¿Ya fue reembolsada?).' });
        }
        const targetTx = buyerHistory[targetTxIndex];

        if (targetTx.status === 'Devuelto') {
            return res.status(400).json({ message: 'Esta transacción ya fue reembolsada anteriormente.' });
        }

        // 3. Verificar saldo del Proveedor
        const providerRes = await client.execute({ sql: 'SELECT balance, transactions_history FROM users WHERE id = ?', args: [numericProviderId] });
        const provider = providerRes.rows[0];
        if (provider.balance < numericAmount) return res.status(400).json({ message: 'Saldo insuficiente en tu cuenta para reembolsar.' });

        // 4. EJECUTAR REEMBOLSO (Proveedor -> Comprador)
        
        // A. Debitar Proveedor
        const newProvBalance = provider.balance - numericAmount;
        const provHistory = JSON.parse(provider.transactions_history || '[]');
        provHistory.unshift({
            id: Date.now(),
            date: new Date().toLocaleDateString('es-PE'),
            description: `REEMBOLSO: ${targetTx.description} (a ${buyer.username})`,
            amount: numericAmount,
            type: 'debit', status: 'Completada', isRefund: true, targetUser: buyer.username
        });
        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newProvBalance, JSON.stringify(provHistory), numericProviderId] });

        // B. Acreditar Comprador y Marcar como Devuelto
        const newBuyerBalance = buyer.balance + numericAmount;
        const refundCreditTx = {
            id: Date.now() + 1,
            date: new Date().toLocaleDateString('es-PE'),
            description: `REEMBOLSO RECIBIDO: ${targetTx.description}`,
            amount: numericAmount,
            type: 'credit', status: 'Completada', isRefund: true
        };
        
        // Marcar original como 'Devuelto'
        buyerHistory[targetTxIndex].status = 'Devuelto';
        buyerHistory[targetTxIndex].details = { ...buyerHistory[targetTxIndex].details, refundDate: new Date().toLocaleDateString('es-PE'), refundAmount: numericAmount };
        buyerHistory.unshift(refundCreditTx);

        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newBuyerBalance, JSON.stringify(buyerHistory), numericBuyerId] });

        // 5. Notificar
        io.emit('transactionsUpdated');
        io.emit('usersUpdated');

        res.status(200).json({ message: 'Reembolso procesado exitosamente.' });

    } catch (error) {
        console.error('Proportional refund error:', error);
        res.status(500).json({ message: 'Error interno al procesar reembolso.' });
    }
});

// 🟢 ENDPOINT: Renovación con Acreditación al Proveedor
app.post('/user/purchase/renovate', async (req, res) => {
    const { userId, purchaseId, months, finalPrice, planType } = req.body;
    const numericUserId = parseInt(userId);
    const numericMonths = parseInt(months);
    const numericFinalPrice = parseFloat(finalPrice);

    if (!numericUserId || !purchaseId || isNaN(numericMonths) || numericMonths < 1 || isNaN(numericFinalPrice)) {
        return res.status(400).json({ message: 'Datos inválidos.' });
    }

    try {
        const userResult = await client.execute({ sql: 'SELECT balance, transactions_history, role, username FROM users WHERE id = ?', args: [numericUserId] });
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const user = userResult.rows[0];

        if (user.balance < numericFinalPrice) return res.status(400).json({ message: 'Saldo insuficiente.' });

        let history = JSON.parse(user.transactions_history || '[]');
        // Búsqueda flexible del ID (puede ser string #ORD o número de renovación previa)
        const targetTx = history.find(tx => String(tx.id) === String(purchaseId) && tx.type === 'debit'); 
        
        if (!targetTx) return res.status(404).json({ message: 'Transacción original no encontrada.' });

        const productName = targetTx.details.productName;
        let originalProviderId = null;
        
        const providerRes = await client.execute({ sql: 'SELECT creator_user_id FROM products WHERE name = ? LIMIT 1', args: [productName] });
        if (providerRes.rows.length > 0) originalProviderId = providerRes.rows[0].creator_user_id;

        // Calcular fechas
        const now = new Date();
        let startRenewalDate = now;
        if (targetTx.details.expirationDate) {
            const parts = targetTx.details.expirationDate.split('/');
            if (parts.length === 3) {
                const existingExpiry = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
                if (existingExpiry > now) startRenewalDate = existingExpiry;
            }
        }
        const newExpiry = new Date(startRenewalDate.getTime());
        newExpiry.setMonth(newExpiry.getMonth() + numericMonths);
        const newExpiryDateStr = newExpiry.toLocaleDateString('es-PE');

        // Transacción Comprador (Renovación)
        const renovationTxId = Date.now(); // ID numérico de la renovación
        const renovationTx = {
            id: renovationTxId,
            date: new Date().toLocaleDateString('es-PE'),
            description: `Renovación: ${productName} (${numericMonths} meses)`,
            amount: numericFinalPrice,
            type: 'debit',
            status: 'Completada',
            details: { ...targetTx.details, planType, cost: numericFinalPrice, expirationDate: newExpiryDateStr, isRenovation: true }
        };

        const updatedHistory = history.map(tx => {
            if (String(tx.id) === String(purchaseId)) {
                tx.details.expirationDate = newExpiryDateStr; // Actualizar original
                return [tx, renovationTx];
            }
            return tx;
        }).flat();

        const newBuyerBalance = user.balance - numericFinalPrice;
        await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newBuyerBalance, JSON.stringify(updatedHistory), numericUserId] });

        // Transacción Proveedor (Crédito por Renovación) - 🟢 AQUI GUARDAMOS EL ENLACE
        if (originalProviderId) {
            const provRes = await client.execute({ sql: 'SELECT balance, transactions_history FROM users WHERE id = ?', args: [originalProviderId] });
            if (provRes.rows.length > 0) {
                const provider = provRes.rows[0];
                const newProvBalance = provider.balance + numericFinalPrice;
                const provHistory = JSON.parse(provider.transactions_history || '[]');

                provHistory.unshift({
                    id: Date.now() + 1,
                    date: new Date().toLocaleDateString('es-PE'),
                    description: `RENOVACIÓN: ${productName} (${user.username})`,
                    amount: numericFinalPrice,
                    type: 'credit',
                    status: 'Completada',
                    isCommission: true, isRenewal: true, sourceUser: user.username,
                    // 🟢 DATOS CLAVE PARA REEMBOLSO
                    buyerUserId: numericUserId,
                    buyerTransactionId: renovationTxId // Guardamos el ID de la renovación
                });

                await client.execute({ sql: 'UPDATE users SET balance = ?, transactions_history = ? WHERE id = ?', args: [newProvBalance, JSON.stringify(provHistory), originalProviderId] });
            }
        }

        io.emit('transactionsUpdated');
        io.emit('usersUpdated');
        res.status(200).json({ message: 'Renovación exitosa.', newBalance: newBuyerBalance.toFixed(2) });

    } catch (error) {
        console.error('Renovation error:', error);
        res.status(500).json({ message: 'Error interno.' });
    }
});

app.post('/user/update-profile', async (req, res) => {
    const { userId, username, phone } = req.body;

    if (!userId || !username || !phone) {
        return res.status(400).json({ message: 'Datos incompletos.' });
    }

    try {
        // 1. Actualizar el username y phone en la base de datos
        await client.execute({
            sql: 'UPDATE users SET username = ?, phone = ? WHERE id = ?',
            args: [username, phone, userId]
        });

        // 2. Emitir un evento para que el frontend del usuario (App.tsx) sepa que debe recargar
        io.emit('profileUpdated', { userId: userId });

        res.status(200).json({ message: 'Perfil actualizado exitosamente.' });

    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Error interno al actualizar el perfil.' });
    }
});

app.post('/supplier/withdraw', async (req, res) => {
    // 🔑 MODIFICADO: Recibir el monto a retirar 'amount'
    const { userId, amount } = req.body; 
    const numericUserId = parseInt(userId);
    const numericAmount = parseFloat(amount); // Monto que el usuario quiere retirar (BRUTO)

    if (isNaN(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ message: "Monto de retiro inválido." });
    }

    try {
        // A. Verificar si ya tiene una solicitud pendiente (Evitar duplicados)
        const pendingRes = await client.execute({
            sql: "SELECT id FROM withdrawals WHERE user_id = ? AND status = 'Pending'",
            args: [numericUserId]
        });
        
        if (pendingRes.rows.length > 0) {
            return res.status(400).json({ message: "Ya tienes una solicitud en proceso. Cancélala o espera la aprobación." });
        }

        // B. Obtener saldo actual
        const userRes = await client.execute({ sql: "SELECT balance FROM users WHERE id = ?", args: [numericUserId] });
        if (userRes.rows.length === 0) return res.status(404).json({ message: "Usuario no encontrado" });
        
        const currentBalance = userRes.rows[0].balance;

        // 🔑 CRÍTICO: Validar que el monto solicitado no exceda el saldo
        // 🟢 FIX: Redondear ambos a 2 decimales para una comparación segura y evitar problemas de coma flotante.
        const requested = parseFloat(numericAmount.toFixed(2));
        const available = parseFloat(currentBalance.toFixed(2));

        if (requested > available) {
            return res.status(400).json({ message: `Monto insuficiente. Tu saldo es ${currentBalance.toFixed(2)}.` });
        }

        // C. Calcular montos (10% comisión)
        const fee = numericAmount * 0.10;
        const finalAmount = numericAmount - fee; // Monto NETO a recibir
        
        // 🔑 CRÍTICO: El monto a descontar de la cartera del proveedor es el monto bruto solicitado.
        const newBalance = currentBalance - numericAmount;

        // D. Crear registro de retiro (Estado Pending)
        await client.execute({
            sql: "INSERT INTO withdrawals (user_id, amount_original, amount_final, status) VALUES (?, ?, ?, 'Pending')",
            args: [numericUserId, numericAmount, finalAmount]
        });

        // E. 🔥 DESCONTAR SALDO BRUTO SOLICITADO
        await client.execute({
            sql: "UPDATE users SET balance = ? WHERE id = ?",
            args: [newBalance, numericUserId]
        });

        // F. Notificar cambios en tiempo real
        io.emit('withdrawalsUpdated'); 
        io.emit('usersUpdated');      

        res.status(200).json({ message: "Solicitud enviada. Tu saldo ha sido descontado temporalmente." });

    } catch (error) {
        console.error("Withdraw error:", error);
        res.status(500).json({ message: "Error al procesar el retiro." });
    }
});

// 2. CANCELAR RETIRO (Proveedor - Solo si está pendiente)
app.post('/supplier/withdraw/cancel', async (req, res) => {
    const { withdrawalId, userId } = req.body;

    try {
        // Verificar que existe y cuánto era el monto original
        const wRes = await client.execute({
            sql: "SELECT amount_original FROM withdrawals WHERE id = ? AND user_id = ? AND status = 'Pending'",
            args: [withdrawalId, userId]
        });

        if (wRes.rows.length === 0) {
            return res.status(400).json({ message: "No se puede cancelar (No encontrado o ya procesado)." });
        }

        const amountToReturn = wRes.rows[0].amount_original;

        // A. Borrar solicitud
        await client.execute({ sql: "DELETE FROM withdrawals WHERE id = ?", args: [withdrawalId] });

        // B. 🔥 DEVOLVER DINERO INMEDIATAMENTE
        await client.execute({
            sql: "UPDATE users SET balance = balance + ? WHERE id = ?",
            args: [amountToReturn, userId]
        });

        // C. Notificar cambios
        io.emit('withdrawalsUpdated'); // Quita la fila de la tabla
        io.emit('usersUpdated');       // 🔥 El saldo vuelve a aparecer en el Header

        res.status(200).json({ message: "Solicitud cancelada. Saldo restaurado." });

    } catch (error) {
        console.error("Cancel withdraw error:", error);
        res.status(500).json({ message: "Error al cancelar." });
    }
});
// 3. OBTENER MIS RETIROS (Proveedor)
app.get('/supplier/withdrawals/:userId', async (req, res) => {
    try {
        const result = await client.execute({
            sql: "SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC",
            args: [req.params.userId]
        });
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Error fetching withdrawals" });
    }
});

// 4. OBTENER TODOS LOS RETIROS (Admin)
app.get('/admin/withdrawals', async (req, res) => {
    try {
        const result = await client.execute(`
            SELECT w.*, u.username, u.phone 
            FROM withdrawals w 
            JOIN users u ON w.user_id = u.id 
            ORDER BY 
                CASE WHEN w.status = 'Pending' THEN 0 ELSE 1 END, 
                w.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Error fetching all withdrawals" });
    }
});

// 5. GESTIONAR RETIRO (Admin: Aprobar/Rechazar)
// MeluFrontend - copia/backend/server.js (Alrededor de la línea 1775)

app.post('/admin/withdraw/manage', async (req, res) => {
    const { withdrawalId, action } = req.body; // action: 'approve' | 'reject'

    try {
        // 1. Obtener la solicitud
        const wRes = await client.execute({ 
            sql: "SELECT * FROM withdrawals WHERE id = ?", 
            args: [withdrawalId] 
        });
        
        if (wRes.rows.length === 0) return res.status(404).json({ message: "Retiro no encontrado" });
        
        const withdrawal = wRes.rows[0];

        // 2. Validar que esté pendiente
        if (withdrawal.status !== 'Pending') {
            return res.status(400).json({ message: "Este retiro ya fue procesado anteriormente." });
        }
        
        let newProviderBalance = null;

        if (action === 'approve') {
            // ✅ APROBAR: Registrar el débito del monto final como transacción
            await client.execute({
                sql: "UPDATE withdrawals SET status = 'Approved' WHERE id = ?",
                args: [withdrawalId]
            });
            
            // 🟢 REGISTRO DE DÉBITO EN HISTORIAL DEL PROVEEDOR
            const providerRes = await client.execute({ 
                sql: 'SELECT transactions_history FROM users WHERE id = ?', 
                args: [withdrawal.user_id] 
            });
            const providerHistory = JSON.parse(providerRes.rows[0].transactions_history || '[]');
            
            providerHistory.unshift({
                id: Date.now() + 1,
                date: new Date().toLocaleDateString('es-PE'),
                description: `RETIRO DE FONDOS APROBADO`,
                amount: withdrawal.amount_final,
                type: 'debit',
                status: 'Completada',
                isWithdrawal: true, // 🟢 Flag de Retiro
                target: 'Cuenta Bancaria'
            });

            await client.execute({
                sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
                args: [JSON.stringify(providerHistory), withdrawal.user_id]
            });

            // Notificación personal al usuario
            const targetSocketId = userSocketMap.get(withdrawal.user_id);
            if (targetSocketId) {
                io.to(targetSocketId).emit('transactionApproved', {
                    message: `¡Tu retiro de $${withdrawal.amount_final.toFixed(2)} ha sido APROBADO y enviado!`,
                });
            }

        } else if (action === 'reject') {
            // ❌ RECHAZAR: Devolver el dinero y registrar el movimiento en el historial
            
            await client.execute({
                sql: "UPDATE withdrawals SET status = 'Rejected' WHERE id = ?",
                args: [withdrawalId]
            });

            // 2. REEMBOLSO AUTOMÁTICO (Devolver el monto bruto original)
            await client.execute({
                sql: "UPDATE users SET balance = balance + ? WHERE id = ?",
                args: [withdrawal.amount_original, withdrawal.user_id]
            });

            // 🟢 REGISTRO DE CRÉDITO EN HISTORIAL DEL PROVEEDOR (Devolución del Saldo)
            const providerRes = await client.execute({ 
                sql: 'SELECT balance, transactions_history FROM users WHERE id = ?', 
                args: [withdrawal.user_id] 
            });
            const providerHistory = JSON.parse(providerRes.rows[0].transactions_history || '[]');
            
            providerHistory.unshift({
                id: Date.now() + 2,
                date: new Date().toLocaleDateString('es-PE'),
                description: `RETIRO RECHAZADO (Saldo Restaurado)`,
                amount: withdrawal.amount_original,
                type: 'credit',
                status: 'Completada',
                isWithdrawalRefund: true, // 🟢 Flag de Reembolso de Retiro
            });
            
            // NOTE: El balance ya se actualizó arriba, solo actualizamos el historial
            await client.execute({
                sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
                args: [JSON.stringify(providerHistory), withdrawal.user_id]
            });

            // Notificación personal al usuario
            const targetSocketId = userSocketMap.get(withdrawal.user_id);
            if (targetSocketId) {
                io.to(targetSocketId).emit('transactionApproved', { 
                    message: `Tu retiro fue RECHAZADO. Se han devuelto $${withdrawal.amount_original.toFixed(2)} a tu cartera.`,
                });
            }
        }

        // 🔥 CRÍTICO: Actualizar en tiempo real
        io.emit('withdrawalsUpdated'); 
        io.emit('usersUpdated');      

        res.status(200).json({ message: `Retiro ${action === 'approve' ? 'Aprobado' : 'Rechazado y reembolsado'} correctamente.` });

    } catch (error) {
        console.error("Manage withdraw error:", error);
        res.status(500).json({ message: "Error interno al gestionar retiro." });
    }
});

app.post('/supplier/support/fix', async (req, res) => {
    const { purchaseId, correctionMessage, newCredentials } = req.body;

    if (!purchaseId || !correctionMessage) {
        return res.status(400).json({ message: 'ID de compra y mensaje de corrección requeridos.' });
    }

    try {
        // 1. Buscar la transacción en todos los usuarios
        const allUsersResult = await client.execute('SELECT id, transactions_history FROM users');
        let targetUserId = null;
        let targetTx = null;
        let userHistory = null;

        for (const user of allUsersResult.rows) {
            const history = JSON.parse(user.transactions_history || '[]');
            targetTx = history.find(tx => tx.id === purchaseId); // Buscamos por ID, el estado puede ser 'Soporte'
            if (targetTx) {
                targetUserId = user.id;
                userHistory = history;
                break;
            }
        }

        if (!targetUserId || !targetTx) {
            return res.status(404).json({ message: 'Transacción no encontrada.' });
        }

        // 2. Actualizar la transacción
        // Estado: 'Esperando aprobación'
        // Guardar la corrección en 'details'
        const updatedHistory = userHistory.map(tx => {
            if (tx.id === purchaseId) {
                return {
                    ...tx,
                    status: 'Esperando aprobación', // Nuevo estado intermedio
                    details: {
                        ...tx.details,
                        correctionMessage: correctionMessage,
                        correctionDate: new Date().toLocaleDateString('es-PE'),
                        // Si hay nuevas credenciales, las guardamos temporalmente o las reemplazamos
                        // Para este flujo, las guardamos en un campo 'proposedCredentials' para que el usuario revise antes
                        proposedCredentials: newCredentials || null 
                    }
                };
            }
            return tx;
        });

        // 3. Guardar en DB
        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), targetUserId]
        });

        // 4. Notificar
        io.emit('transactionsUpdated');

        res.status(200).json({ message: 'Corrección enviada. Esperando aprobación del cliente.' });

    } catch (error) {
        console.error('Support fix error:', error);
        res.status(500).json({ message: 'Error al enviar la corrección.' });
    }
});


// MeluFrontend - copia/backend/server.js (Nuevo Endpoint)

// 🟢 ENDPOINT: Obtener historial financiero del proveedor (Ventas, Renovaciones, Retiros, Reembolsos)
app.get('/supplier/financial-transactions/:providerId', async (req, res) => {
    const { providerId } = req.params;
    try {
        const result = await client.execute({ sql: 'SELECT transactions_history FROM users WHERE id = ?', args: [providerId] });
        if (result.rows.length === 0) return res.status(404).json({ message: 'Proveedor no encontrado.' });
        
        const history = JSON.parse(result.rows[0].transactions_history || '[]');
        const consolidatedList = [];

        history.forEach(tx => {
            if (tx.status === 'Completada' && (tx.isCommission || tx.isRefund || tx.isWithdrawal || tx.isWithdrawalRefund)) {
                consolidatedList.push({
                    id: tx.id,
                    date: tx.date,
                    amount: tx.amount,
                    type: tx.type, 
                    description: tx.description,
                    sourceUser: tx.sourceUser || tx.targetUser || 'Cliente',
                    isRenewal: tx.isRenewal || false,
                    isRefund: tx.isRefund || false,
                    isWithdrawal: tx.isWithdrawal || tx.isWithdrawalRefund || false,
                    status: tx.status,
                    // 🟢 ENVIAMOS LOS IDs GUARDADOS
                    buyerUserId: tx.buyerUserId,
                    buyerTransactionId: tx.buyerTransactionId
                });
            }
        });
        
        consolidatedList.sort((a, b) => b.id - a.id);
        res.status(200).json(consolidatedList);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener transacciones.' });
    }
});

// 🔑 ENDPOINT NUEVO: Usuario aprueba la corrección
app.post('/user/support/approve', async (req, res) => {
    const { userId, purchaseId } = req.body;

    try {
        const userResult = await client.execute({ sql: 'SELECT transactions_history FROM users WHERE id = ?', args: [userId] });
        if (userResult.rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        let history = JSON.parse(userResult.rows[0].transactions_history || '[]');
        let transactionFound = false;

        const updatedHistory = history.map(tx => {
            if (tx.id === purchaseId && tx.status === 'Esperando aprobación') {
                transactionFound = true;
                
                // Aplicar los cambios propuestos si existen
                let finalCredentials = tx.details.fullCredentials;
                if (tx.details.proposedCredentials) {
                    // Aquí podrías reemplazar completamente o actualizar. 
                    // Asumimos que proposedCredentials es un array que reemplaza al anterior si se aprueba.
                    // O si es un solo objeto, lo metemos en el array.
                    // Adaptaremos según lo que envíe el proveedor.
                    finalCredentials = tx.details.proposedCredentials; 
                }

                return {
                    ...tx,
                    status: 'Completada', // Vuelve a estado normal (Mis Compras)
                    details: {
                        ...tx.details,
                        fullCredentials: finalCredentials,
                        supportMessage: null, // Limpiamos flags de soporte
                        supportDate: null,
                        correctionMessage: null, // Limpiamos datos temporales de corrección
                        proposedCredentials: null,
                        correctionDate: null
                    }
                };
            }
            return tx;
        });

        if (!transactionFound) return res.status(400).json({ message: 'Transacción no válida para aprobación.' });

        await client.execute({
            sql: 'UPDATE users SET transactions_history = ? WHERE id = ?',
            args: [JSON.stringify(updatedHistory), userId]
        });

        io.emit('transactionsUpdated');
        res.status(200).json({ message: 'Corrección aprobada. Producto disponible en Mis Compras.' });

    } catch (error) {
        console.error('Support approve error:', error);
        res.status(500).json({ message: 'Error al aprobar la corrección.' });
    }
});

// Inicializar DB, sembrar Admin y arrancar servidor
initializeDb()
    .then(seedAdminUser)
    .then(assignReferralCodesToExistingUsers)
    .then(() => {
        // Usar httpServer para escuchar
        httpServer.listen(PORT, () => {
            console.log(`Backend Server running on http://localhost:${PORT}`);
            console.log(`Socket.io running on http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error("Failed to start server due to DB initialization or seeding error:", err);
        process.exit(1);
    });