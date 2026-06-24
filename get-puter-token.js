const http = require("http")

async function main() {
    const { default: open } = await import("open")

    const server = http.createServer((req, res) => {
        const token = new URL(req.url, "http://localhost").searchParams.get("token")

        res.writeHead(200, { "Content-Type": "text/html" })
        res.end("<h1>Login Puter berhasil</h1><p>Kembali ke terminal dan salin tokennya.</p>")

        if (token) {
            console.log("\nPUTER_AUTH_TOKEN=" + token + "\n")
            server.close()
        }
    })

    server.listen(0, () => {
        const { port } = server.address()
        const redirectURL = `http://localhost:${port}`
        const url = `https://puter.com/?action=authme&redirectURL=${encodeURIComponent(redirectURL)}`

        console.log("Membuka browser untuk login Puter...")
        open(url)
    })
}

main().catch((error) => {
    console.error("Gagal mengenerate :", error.message || error)
})
