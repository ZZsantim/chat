import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
    
const firebaseConfig = {
  apiKey: "AIzaSyClNMAvE7Qi9v0RWG2fQzFgAXiLUnjpA5c",
  authDomain: "colegio-proyecto-4c9c2.firebaseapp.com",
  projectId: "colegio-proyecto-4c9c2",
  storageBucket: "colegio-proyecto-4c9c2.firebasestorage.app",
  messagingSenderId: "720019623332",
  appId: "1:720019623332:web:ee2b1b773cc28d90594531"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);