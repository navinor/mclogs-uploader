// ==UserScript==
// @name         mclo.gs Log Uploader
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Upload log files to mclo.gs.
// @author       Navinor
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      api.mclo.gs
// @connect      *
// @run-at       document-body
// @updateURL    https://raw.githubusercontent.com/navinor/mclogs-uploader/refs/heads/main/mclogs-uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/navinor/mclogs-uploader/refs/heads/main/mclogs-uploader.user.js
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
// ==/UserScript==

(function() {
    'use strict';

    let lastLogLink = null;

    // Add custom CSS for our upload button and notifications
	GM_addStyle(`
		#mclogs-toast-container {
			position: fixed;
			top: 20px;
			right: 20px;
			display: flex;
			flex-direction: column;
			align-items: flex-end;   /* keep cards right-aligned            */
			gap: 10px;               /* spacing between cards               */
			z-index: 10001;
			pointer-events: none;    /* clicks pass through empty space     */
		}

		.mclogs-notification {
			background: #2d3142;
			color: #ffffff;
			padding: 16px 20px;
			border-radius: 8px;
			border-left: 4px solid #4CAF50;
			box-shadow: 0 4px 12px rgba(0,0,0,0.3);
			max-width: 350px;
			font-family: Arial, sans-serif;
			font-size: 14px;
			opacity: 0;
			transform: translateX(100%);
			transition: all 0.3s ease;
			pointer-events: auto;    /* links/buttons remain clickable      */
		}

		.mclogs-notification.show {
			opacity: 1;
			transform: translateX(0);
		}

		.mclogs-notification.slideout {
			opacity: 0;
			transform: translateX(100%);
		}

		.mclogs-notification.error {
			border-left-color: #f44336;
		}

		.mclogs-notification-title {
			font-weight: bold;
			margin-bottom: 4px;
		}

		.mclogs-notification-message {
			font-size: 12px;
			line-height: 1.4;
			color: #d1d5db;
		}
	`);

    // Check if URL appears to be a log file
    function isLogFile(url) {
        if (!url) return false;

        const logExtensions = ['.log', '.txt', '.out', '.crash'];
        const urlLower = url.toLowerCase();

        return logExtensions.some(ext => urlLower.includes(ext)) ||
               urlLower.includes('log') ||
               urlLower.includes('crash') ||
               urlLower.includes('latest');
    }

    function flipStack(container, mutator) {
        // snapshot: element ➜ starting-top
        const firstTops = new Map(
            Array.from(container.children).map(el => [el, el.getBoundingClientRect().top])
        );

        // mutate DOM (add / remove / reorder)
        mutator();

        // measure new tops & animate the delta
        Array.from(container.children).forEach(el => {
            const from = firstTops.get(el); // undefined ⇒ brand-new toast
            if (from === undefined) return;

            const to = el.getBoundingClientRect().top;
            const delta = from - to; // positive = moved up

            if (!delta) return; // no movement needed

            // play the FLIP
            el.style.transition = 'transform 0s';
            el.style.transform = `translateY(${delta}px)`;

            requestAnimationFrame(() => {
                el.style.transition = 'transform 200ms ease';
                el.style.transform = '';
            });
        });
    }
    // Create and show custom notification
    function showNotification(title, message, isError = false) {
        // ensure a flexbox container exists
        let container = document.getElementById('mclogs-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'mclogs-toast-container';
            container.style.pointerEvents = 'none'; // clicks pass between toasts
            document.body.appendChild(container);
        }

        // Build the toast element
        const toast = document.createElement('div');
        toast.className = `mclogs-notification${isError ? ' error' : ''}`;

        const msgBox = document.createElement('div');
        msgBox.className = 'mclogs-notification-message';
        msgBox.textContent = message;

        toast.innerHTML =
            `<div class="mclogs-notification-title">${title}</div>`;
        toast.appendChild(msgBox);

        // INSERT with FLIP so older toasts slide down
        flipStack(container, () => container.appendChild(toast));

        // slide-in opacity/translateX
        requestAnimationFrame(() => toast.classList.add('show'));

        // auto-dismiss after 5 s, then FLIP again so others slide up
        setTimeout(() => {
            toast.style.transition = '';
            toast.classList.add('slideout');
            setTimeout(() => {
                flipStack(container, () => toast.remove());
            }, 300);
        }, 5000);

        return msgBox; // caller can still append extra nodes
    }

    async function fetchLogContent(url) {
    // detect .log.gz (optionally with query-string)
    if (/\.log\.gz($|\?)/i.test(url)) {
        // download bytes
        const buffer = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                onload(res) {
                    if (res.status === 200) resolve(res.response);
                    else reject(new Error(`HTTP ${res.status}`));
                },
                onerror() { reject(new Error('Network error')); }
            });
        });

        // decompress
        try {
            const compressed = new Uint8Array(buffer);
            return pako.ungzip(compressed, { to: 'string' });
        } catch (e) {
            throw new Error('Gzip decompression failed: ' + e.message);
        }
    }

    // else, regular text fetch
    return await fetchFileContent(url);
}

    // Send content to mclo.gs API
    function sendToMclogs(content) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: 'https://api.mclo.gs/1/log',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                data: `content=${encodeURIComponent(content)}`,
                onload: function (response) {
                    const { status, responseText, responseHeaders } = response;
                    if (status === 200) {
                        let json;
                        try {
                            json = JSON.parse(responseText);
                        } catch (e) {
                            return reject(new Error('Malformed JSON from server'));
                        }

                        if (json && json.success) {
                            return resolve({ success: true, url: json.url, id: json.id });
                        }
                        return reject(new Error(json?.error || 'Upload failed (unknown cause)'));
                    }
                    if (status === 429) {
                        const retryAfter = (responseHeaders||'')
                        .match(/Retry-After:\s*(\d+)/i)?.[1];
                        const msg = retryAfter
                        ? `Rate limit exceeded – wait ${retryAfter}s and try again.`
                        : 'Rate limit exceeded. Try again later.';
                        return reject(new Error(msg));
                    }
                    return reject(
                        new Error(`HTTP ${status}: ${responseText.slice(0, 120)}`)
                    );
                },
                onerror: function() {
                    reject(new Error('Network error occurred'));
                }
            });
        });
    }

    // Fetch file content
    function fetchFileContent(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url,
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response.responseText);
                    } else {
                        reject(new Error(`HTTP error! status: ${response.status}`));
                    }
                },
                onerror: function(response) {
                    reject(new Error('Failed to fetch file'));
                }
            });
        });
    }

    async function copyToClipboard(text) {
        try {
            GM_setClipboard(text, { type: 'text', mimetype: 'text/plain' });
            return true;
        } catch (err) {
            if (navigator.clipboard?.writeText) {
                try {
                    await navigator.clipboard.writeText(text);
                    return true;
                } catch (e) {
                    console.warn('Navigator clipboard failed:', e);
                }
            }
            console.warn('Clipboard copy failed:', err);
            return false;
        }
    }



    // Handle the upload process
    async function handleUpload(linkUrl) {
        try {
            showNotification(
                '⏳ Uploading to mclo.gs',
                'Downloading and uploading log file...'
            );

            // Fetch the file content
            const content = await fetchLogContent(linkUrl);
            // Send to mclo.gs
            const result = await sendToMclogs(content);

            if (result.success) {
                // Copy URL to clipboard
                const copied = await copyToClipboard(result.url);

                // Build link
                const linkEl = document.createElement('a');
                linkEl.href = result.url;
                linkEl.textContent = result.url;
                linkEl.target = '_blank';
                linkEl.rel = 'noopener noreferrer';

                const msgBox = showNotification(
                    '✅ Upload Successful!',
                    'Log uploaded to mclo.gs! URL copied to clipboard: '
                );
                msgBox.appendChild(linkEl);
                lastLogLink = null;
                return;
            } else {
                throw new Error('Upload failed');
            }

        } catch (error) {
            console.error('Error uploading to mclo.gs:', error);
            showNotification(
                '❌ Upload Failed',
                `Failed to upload log: ${error.message}`,
                true
            );
        }
    }


    // Track last right-clicked link
    document.addEventListener(
        'contextmenu',
        e => {
            const link = e.target.closest('a');
            if (link && link.href && isLogFile(link.href)) {
                lastLogLink = link.href;
            }
        },
        { capture: false, passive: true }
    );

    // Register menu command for uploading right-clicked log link
    GM_registerMenuCommand("📤 Upload to mclo.gs", function() {
        if (lastLogLink) {
            handleUpload(lastLogLink);
        } else {
            showNotification(
                'ℹ️ No Log Link Found',
                'Make sure you\'ve right-clicked a link!'
            );
        }
    });

    console.log('mclo.gs Log Uploader registered.');
})();
