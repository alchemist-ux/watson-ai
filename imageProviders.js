const { getEnv } = require("./env")
const fs = require("fs")
const path = require("path")
const vm = require("vm")
const { spawn } = require("child_process")

let puterInstance = null
const shortErrorText = "bot sedang error"

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveImageProvider() {
    return (getEnv("IMAGE_PROVIDER") || "puter").toLowerCase()
}

function unwrapTaskPayload(raw) {
    if (!raw || typeof raw !== "object") return {}
    if (raw.data && typeof raw.data === "object" && ("successFlag" in raw.data || raw.data.taskId)) {
        return raw.data
    }
    return raw
}

function getSuccessFlag(payload) {
    const flag = payload?.successFlag
    if (flag === undefined || flag === null || flag === "") return null
    const num = Number(flag)
    return Number.isNaN(num) ? null : num
}

function getResultImageUrl(payload) {
    const response = payload?.response || {}
    const urls = [
        response.resultImageUrl,
        response.originImageUrl,
        response.result_image_url,
        payload?.resultImageUrl,
    ]
    return urls.find((url) => typeof url === "string" && url.startsWith("http")) || null
}

function imageBufferToDataUrl(buffer, mimeType = "image/jpeg") {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return ""
    return `data:${mimeType};base64,${buffer.toString("base64")}`
}

async function uploadReferenceImage(buffer, mimeType = "image/jpeg") {
    if (getEnv("NANOBANANA_UPLOAD_REFERENCES") === "false") return null
    if (typeof FormData !== "function" || typeof Blob !== "function") return null

    const uploadUrl = getEnv("NANOBANANA_REFERENCE_UPLOAD_URL") || "https://tmpfiles.org/api/v1/upload"
    const extension = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg"
    const form = new FormData()
    form.append("file", new Blob([buffer], { type: mimeType }), `whatsapp-image.${extension}`)

    const response = await fetch(uploadUrl, {
        method: "POST",
        body: form,
    })
    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
        throw new Error(data.message || data.error || `upload error ${response.status}`)
    }

    const rawUrl = data.data?.url || data.link || data.url
    if (typeof rawUrl !== "string" || !rawUrl.startsWith("http")) {
        throw new Error("upload berhasil tapi URL gambar kosong")
    }

    return rawUrl.replace("tmpfiles.org/", "tmpfiles.org/dl/")
}

async function downloadImageUrl(url) {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) {
        throw new Error(`Gagal mengunduh gambar (${response.status})`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1000) {
        throw new Error("Data gambar kosong atau tidak valid")
    }
    return buffer
}

function loadPuter() {
    if (puterInstance) return puterInstance

    const authToken = getEnv("PUTER_AUTH_TOKEN")
    if (!authToken) {
        throw new Error(shortErrorText)
    }

    const puterPath = path.join(__dirname, "node_modules", "@heyputer", "puter.js", "dist", "puter.cjs")
    const code = fs.readFileSync(puterPath, "utf8")
    const context = {}

    for (const name of Object.getOwnPropertyNames(globalThis)) {
        try {
            context[name] = globalThis[name]
        } catch {
            // Abaikan global yang tidak bisa dibaca.
        }
    }

    context.globalThis = context
    context.PUTER_API_ORIGIN = globalThis.PUTER_API_ORIGIN
    context.PUTER_ORIGIN = globalThis.PUTER_ORIGIN

    vm.runInNewContext(code, vm.createContext(context))
    context.puter.setAuthToken(authToken)
    puterInstance = context.puter
    return puterInstance
}

function dataUrlToBuffer(dataUrl) {
    const match = String(dataUrl || "").match(/^data:image\/[^;]+;base64,(.+)$/)
    if (!match) return null
    return Buffer.from(match[1], "base64")
}

function withTimeout(promise, ms, label) {
    let timeout
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout setelah ${ms / 1000} detik`)), ms)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

async function resultToImageBuffer(result) {
    const value = typeof result === "string" ? result : result?.src || result?.url || result?.data

    if (typeof value !== "string") {
        throw new Error(shortErrorText)
    }

    if (value.startsWith("data:image/")) {
        const buffer = dataUrlToBuffer(value)
        if (!buffer?.length) throw new Error(shortErrorText)
        return buffer
    }

    if (value.startsWith("http")) {
        return downloadImageUrl(value)
    }

    throw new Error(shortErrorText)
}

async function generatePuterImage(prompt, options = {}) {
    const cleanPrompt = String(prompt || "").trim()
    if (!cleanPrompt) {
        return { ok: false, error: shortErrorText }
    }

    const testMode = getEnv("PUTER_TEST_MODE") === "true"
    const model = getEnv("PUTER_IMAGE_MODEL") || "openai/gpt-image-1-mini"
    const provider = getEnv("PUTER_IMAGE_PROVIDER") || "openai-image-generation"
    const quality = getEnv("PUTER_IMAGE_QUALITY") || "low"
    const timeoutMs = Number(getEnv("PUTER_TIMEOUT_MS")) || 60000

    try {
        const result = await runPuterWorker({
            prompt: cleanPrompt,
            provider,
            model,
            quality,
            testMode,
            timeoutMs,
        })

        if (!result.ok) {
            if (result.code === "invalid_image_response" || /Unexpected image response format/i.test(result.error || "")) {
                return {
                    ok: false,
                    error: shortErrorText,
                }
            }

            return {
                ok: false,
                error: shortErrorText,
            }
        }

        const buffer = Buffer.from(result.base64, "base64")
        if (!buffer.length) {
            return { ok: false, error: shortErrorText }
        }

        return {
            ok: true,
            buffer,
            revisedPrompt: cleanPrompt,
            model,
            provider: "puter",
            mode: "text-to-image",
        }
    } catch (error) {
        return { ok: false, error: shortErrorText }
    }
}

function runPuterWorker(input) {
    return new Promise((resolve) => {
        const timeoutMs = input.timeoutMs || 60000
        const child = spawn(process.execPath, [path.join(__dirname, "puter-worker.js"), JSON.stringify(input)], {
            cwd: __dirname,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        })

        let stdout = ""
        let stderr = ""
        let settled = false

        const finish = (result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { child.kill() } catch { /* ignore */ }
            resolve(result)
        }

        const timer = setTimeout(() => {
            finish({ ok: false, error: shortErrorText })
        }, timeoutMs)

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString()
        })

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString()
        })

        child.on("error", (error) => {
            finish({ ok: false, error: shortErrorText })
        })

        child.on("close", () => {
            if (settled) return
            try {
                const parsed = JSON.parse(stdout.trim())
                finish(parsed)
            } catch {
                finish({ ok: false, error: shortErrorText })
            }
        })
    })
}

async function submitNanobananaTask(apiKey, baseUrl, cleanPrompt, callBackUrl, imageUrls = []) {
    const hasInputImages = Array.isArray(imageUrls) && imageUrls.length > 0
    const useV2 = hasInputImages || getEnv("NANOBANANA_USE_V2") === "true" || getEnv("NANOBANANA_API_VERSION") === "2"

    if (useV2) {
        const response = await fetch(`${baseUrl}/generate-2`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                prompt: cleanPrompt.slice(0, 20000),
                imageUrls,
                aspectRatio: getEnv("SQUERS_IMAGE_SIZE") || "auto",
                resolution: getEnv("NANOBANANA_RESOLUTION") || "1K",
                outputFormat: "jpg",
                callBackUrl,
            }),
        })
        const data = await response.json().catch(() => ({}))
        const ok = response.ok && (data.code === 200 || data.code === undefined)
        return {
            ok,
            taskId: data.data?.taskId,
            error: shortErrorText,
        }
    }

    const response = await fetch(`${baseUrl}/generate`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            prompt: cleanPrompt.slice(0, 20000),
            type: hasInputImages ? "IMAGETOIAMGE" : "TEXTTOIAMGE",
            imageUrls,
            numImages: 1,
            image_size: getEnv("NANOBANANA_IMAGE_SIZE") || "1:1",
            callBackUrl,
        }),
    })
    const data = await response.json().catch(() => ({}))
    return {
        ok: response.ok && data.code === 200,
        taskId: data.data?.taskId,
        error: shortErrorText,
    }
}

async function pollNanobananaTask(apiKey, baseUrl, taskId, maxWaitMs, pollMs) {
    const startedAt = Date.now()
    let lastFlag = null

    while (Date.now() - startedAt < maxWaitMs) {
        const statusResponse = await fetch(
            `${baseUrl}/record-info?taskId=${encodeURIComponent(taskId)}`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        )
        const statusRaw = await statusResponse.json().catch(() => ({}))

        if (!statusResponse.ok) {
            return {
                ok: false,
                error: shortErrorText,
            }
        }

        if (statusRaw.code && statusRaw.code !== 200) {
            return {
                ok: false,
                error: shortErrorText,
            }
        }

        const payload = unwrapTaskPayload(statusRaw)
        const flag = getSuccessFlag(payload)
        lastFlag = flag

        if (flag === 1) {
            const imageUrl = getResultImageUrl(payload)
            if (!imageUrl) {
                return { ok: false, error: shortErrorText }
            }
            const buffer = await downloadImageUrl(imageUrl)
            return { ok: true, buffer }
        }

        if (flag === 2) {
            return {
                ok: false,
                error: shortErrorText,
            }
        }

        if (flag === 3) {
            return {
                ok: false,
                error: shortErrorText,
            }
        }

        await sleep(pollMs)
    }

    return { ok: false, error: shortErrorText }
}

async function generateImage(prompt, options = {}) {
    const cleanPrompt = String(prompt || "").trim()
    if (!cleanPrompt) {
        return { ok: false, error: shortErrorText }
    }

    const provider = resolveImageProvider()
    const imageUrls = Array.isArray(options.imageUrls) ? options.imageUrls.filter(Boolean) : []

    if (provider === "puter") {
        if (imageUrls.length) {
            if (!getEnv("NANOBANANA_API_KEY")) {
                return {
                    ok: false,
                    error: shortErrorText,
                }
            }
        } else {
            const puterResult = await generatePuterImage(cleanPrompt, options)
            if (puterResult.ok || !getEnv("NANOBANANA_API_KEY")) return puterResult

            console.warn(`[IMG] Puter gagal, fallback`)
        }
    }

    const apiKey = getEnv("NANOBANANA_API_KEY")
    if (!apiKey) {
        return {
            ok: false,
            error: shortErrorText,
        }
    }

    const baseUrl = "https://api.nanobananaapi.ai/api/v1/nanobanana"
    const callBackUrl = getEnv("NANOBANANA_CALLBACK_URL") || "https://httpbin.org/post"
    const maxWaitMs = Number(getEnv("NANOBANANA_MAX_WAIT_MS")) || 300000
    const pollMs = Number(getEnv("NANOBANANA_POLL_MS")) || 2000

    try {
        const submit = await submitNanobananaTask(apiKey, baseUrl, cleanPrompt, callBackUrl, imageUrls)
        if (!submit.ok || !submit.taskId) {
            return { ok: false, error: shortErrorText }
        }

        console.log(`[IMG] Task ${submit.taskId} — menunggu gambar...`)
        const poll = await pollNanobananaTask(apiKey, baseUrl, submit.taskId, maxWaitMs, pollMs)
        if (!poll.ok) {
            return { ok: false, error: shortErrorText }
        }

        return {
            ok: true,
            buffer: poll.buffer,
            revisedPrompt: cleanPrompt,
            model: "nanobanana",
            provider: "nanobanana",
            mode: imageUrls.length ? "image-to-image" : "text-to-image",
        }
    } catch (error) {
        return { ok: false, error: shortErrorText }
    }
}

async function editImage(prompt, imageBuffer, mimeType = "image/jpeg") {
    if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
        return { ok: false, error: shortErrorText }
    }

    const cleanPrompt = String(prompt || "").trim()
    if (!cleanPrompt) {
        return { ok: false, error: shortErrorText }
    }

    let imageUrl = null
    try {
        imageUrl = await uploadReferenceImage(imageBuffer, mimeType)
    } catch (error) {
        console.warn(`[IMG] Gagal upload referensi, fallback data URL`)
    }

    imageUrl = imageUrl || imageBufferToDataUrl(imageBuffer, mimeType)
    if (!imageUrl) {
        return { ok: false, error: shortErrorText }
    }

    return generateImage(cleanPrompt, { imageUrls: [imageUrl] })
}

module.exports = {
    generateImage,
    editImage,
    generatePuterImage,
    resolveImageProvider,
}


