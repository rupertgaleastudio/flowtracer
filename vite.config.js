import { defineConfig } from 'vite';

export default defineConfig({
    // Big HDRIs get locked by windows while copying so don't let watcher touch them
    server: {watch: {ignored: ['**public/hdri/**'] } },
});