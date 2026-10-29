/*
 * Local dev plugin. Not part of upstream Vencord.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

export default definePlugin({
    name: "HelloDev",
    description: "Starter plugin. Edit this file, save, then reload Discord with Ctrl+R.",
    authors: [{ name: "you", id: 0n }],
    start() {
        console.log("[HelloDev] plugin started");
    },
    stop() {
        console.log("[HelloDev] plugin stopped");
    }
});

