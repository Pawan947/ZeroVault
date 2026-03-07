const firebase = require("firebase/app");
const { getAuth } = require("firebase/auth");
const { getDatabase } = require("firebase/database");
require("dotenv").config();

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
};

firebase.initializeApp(firebaseConfig);

const auth = getAuth();
const db = getDatabase();

module.exports = { auth, db };
