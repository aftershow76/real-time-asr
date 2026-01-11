/**
 * ARI Snoop Manager
 * - Creates spy=in and spy=out snoops
 * - Wires ExternalMedia RTP streams
 * - Registers calls with ASR Gateway
 */

require("dotenv").config();
const ari = require("ari-client");
const crypto = require("crypto");


const {
  ARI_URL,
  ARI_USER,
  ARI_PASS,
  ARI_APP,
  ASR_RTP_HOST,
  ASR_RTP_BASE_PORT,
  ASR_RTP_CODEC,
  ASR_GATEWAY_HTTP
} = process.env;

const sessions = new Map();
const STASIS_GONE_MESSAGE = "Channel not in Stasis application";

function hash(val) {
  return crypto.createHash("sha1").update(String(val)).digest("hex").slice(0, 8);
}

function pickPorts(linkedid) {
  const base = Number(ASR_RTP_BASE_PORT) + (parseInt(hash(linkedid), 16) % 2000) * 4;
  return { in: base, out: base + 2 };
}

async function getChannelVarSafe(client, channelId, variable) {
  try {
    const result = await client.channels.getChannelVar({ channelId, variable });
    return result.value;
  } catch (error) {
    const message = error && error.message ? String(error.message) : "";
    if (message.includes("Provided variable was not found")) {
      return null;
    }
    throw error;
  }
}

async function registerCall(session) {
  await fetch(`${ASR_GATEWAY_HTTP}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callId: session.linkedid,
      uniqueid: session.uniqueid,
      portIn: session.ports.in,
      portOut: session.ports.out
    })
  });
}

async function unregisterCall(linkedid) {
  await fetch(`${ASR_GATEWAY_HTTP}/unregister`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId: linkedid })
  });
}

function isStasisGoneError(error) {
  const message = error && error.message ? String(error.message) : "";
  return message.includes(STASIS_GONE_MESSAGE);
}

async function cleanupSession(client, session) {
  for (const id of [...session.snoops, ...session.externals]) {
    try {
      await client.channels.hangup({ channelId: id });
    } catch (error) {
      if (!isStasisGoneError(error)) {
        console.warn("Failed to hangup channel", id, error);
      }
    }
  }
  for (const id of session.bridges) {
    try {
      await client.bridges.destroy({ bridgeId: id });
    } catch (error) {
      console.warn("Failed to destroy bridge", id, error);
    }
  }
}

ari.connect(ARI_URL, ARI_USER, ARI_PASS, (err, client) => {
  if (err) {
    console.error("Failed to connect to ARI:", err);
    return;
  }

  client.on("StasisStart", (evt, channel) => {
    (async () => {
      const args = Object.fromEntries((evt.args || []).map(a => a.split("=")));
      if (args.kind === "snoop") return;

      const linkedid =
        (await getChannelVarSafe(client, channel.id, "LINKEDID")) ||
        channel.linkedid ||
        channel.id;

      const uniqueid =
        (await getChannelVarSafe(client, channel.id, "UNIQUEID")) ||
        channel.uniqueid ||
        channel.id;

      const ports = pickPorts(linkedid);

      const session = {
        channelId: channel.id,
        linkedid,
        uniqueid,
        ports,
        snoops: [],
        externals: [],
        bridges: []
      };
      sessions.set(channel.id, session);

      // Create snoops
      for (const dir of ["in", "out"]) {
        const snoop = await client.channels.snoopChannel({
          channelId: channel.id,
          app: ARI_APP,
          spy: dir,
          appArgs: `kind=snoop;dir=${dir}`
        });
        session.snoops.push(snoop.id);
      }

      // ExternalMedia
      const extIn = await client.channels.externalMedia({
        app: ARI_APP,
        external_host: `${ASR_RTP_HOST}:${ports.in}`,
        format: ASR_RTP_CODEC,
        direction: "out"
      });

      const extOut = await client.channels.externalMedia({
        app: ARI_APP,
        external_host: `${ASR_RTP_HOST}:${ports.out}`,
        format: ASR_RTP_CODEC,
        direction: "out"
      });

      session.externals.push(extIn.id, extOut.id);

      // Bridges
      for (let i = 0; i < 2; i++) {
        const bridge = await client.bridges.create({ type: "mixing" });
        await client.bridges.addChannel({
          bridgeId: bridge.id,
          channel: `${session.snoops[i]},${session.externals[i]}`
        });
        session.bridges.push(bridge.id);
      }

      await registerCall(session);

      await client.channels.continueInDialplan({
        channelId: channel.id,
        context: args.retctx,
        extension: args.retexten,
        priority: Number(args.retpri)
      });
    })().catch(async error => {
      if (!isStasisGoneError(error)) {
        console.error("Failed to handle StasisStart", error);
      }
      const session = sessions.get(channel.id);
      if (session) {
        await cleanupSession(client, session);
        sessions.delete(channel.id);
      }
    });
  });

  client.on("StasisEnd", (evt, channel) => {
    (async () => {
      const session = sessions.get(channel.id);
      if (!session) return;

      await unregisterCall(session.linkedid);
      await cleanupSession(client, session);
      sessions.delete(channel.id);
    })().catch(error => {
      console.error("Failed to handle StasisEnd", error);
    });
  });

  client.start(ARI_APP);
});
