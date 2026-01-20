import axios from 'axios';

// Create an instance with your backend port
const API = axios.create({
  baseURL: 'http://localhost:5000/api',
});

export default API;