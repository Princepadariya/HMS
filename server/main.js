import { start } from './index.js';

const { port } = await start();
console.log(`Hotel ERP running: staff app http://localhost:${port}  |  booking site http://localhost:${port}/book`);
