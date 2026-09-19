import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Sem StrictMode de proposito: o Player registra <video>/<audio> de forma
// imperativa, e o duplo-mount do StrictMode derruba a sincronia de audio.
createRoot(document.getElementById('root')!).render(<App />);
