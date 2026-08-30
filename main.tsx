import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import './app/globals.css';
import { QuantumGame } from './app/quantum-game';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><QuantumGame /></React.StrictMode>,
);
