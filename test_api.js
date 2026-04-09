// No import needed for Node 18+

async function test() {
    try {
        const res = await fetch('https://bank-app-sandy-pi.vercel.app/api/health', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(e);
    }
}

test();
