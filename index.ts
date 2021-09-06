import fetch from 'node-fetch';
import * as fs from "fs";
import {ColorResolvable, DiscordAPIError, MessageEmbed, WebhookClient} from "discord.js";
import {time} from "@discordjs/builders";

const config = require("config");
const _ = require("lodash");

const apiUrl = "https://discordstatus.com/api/v2/incidents.json";
const fileName = "./messages.json";

const webhookClient = new WebhookClient({id: config.id, token: config.token});
const ignoreTime = (config["ignoreDays"]??30) * 86400000;
console.log(`Ignoring incidents from ${config["ignoreDays"]??30} days ago (${ignoreTime} ms).`);

async function checkFile() {
    if (fs.existsSync(fileName)) return;
    fs.writeFileSync(fileName, JSON.stringify({}));
}

async function readJsonFile() {
    const data = fs.readFileSync(fileName, "utf-8");
    return JSON.parse(data);
}

async function checkIncident(incident: any) {
    let id = incident.id;
    const incidentUpdate = Date.parse(incident.updated_at);

    if (Date.now() - incidentUpdate > ignoreTime) {
        console.debug(`Skipping update of incident ${id} because it's too old.`);
        return;
    }

    let messageId = await getMessageIdFromIncident(id);
    if (messageId === undefined) {
        await createMessage(incident);
        return;
    }
    let message = undefined;
    try {
        message = await webhookClient.fetchMessage(messageId);
    } catch (e) {
        if (e === DiscordAPIError) {
            await createMessage(incident);
            return;
        }
    }

    if (message === undefined) {
        await createMessage(incident);
        return;
    }

    if (message.embeds.length > 0) {
        const messageUpdate = Date.parse(message.embeds[0].timestamp);
        const diff = messageUpdate - incidentUpdate;
        if (diff !== 0) {
            await updateMessage(message, incident);
            return;
        }
    } else {
        await updateMessage(message, incident);
    }
}

async function updateMessage(message, incident: any) {
    let id = incident.id;
    console.log(`Updating message of incident ${id}.`);
    await webhookClient.editMessage(message, {
        embeds: [buildEmbed(incident)],
    })
}

function getColor(status: string) : ColorResolvable {
    switch (status) {
        case "resolved": return "#06a51b";
        case "monitoring": return "#a3a506";
        case "identified": return "#a55806";
    }
    return "#a50626";
}
function buildEmbed(incident: any) : MessageEmbed {
    const embed = new MessageEmbed()
        .setTitle(incident.name)
        .setURL(incident.shortlink)
        .setColor(getColor(incident.status))
        .setFooter(incident.id)
        .setTimestamp(incident.updated_at);

    let components = [];
    for (let i in incident.components) {
        let component = incident.components[i];
        components.push(component.name);
    }

    embed.setDescription(`• Impact: ${incident.impact}\n• Affected Components: ${components.join(", ")}`);

    for (let i in incident.incident_updates) {
        let update = incident.incident_updates[i];
        let timeString = " (" + time(new Date(update.created_at), "R") + ")";
        embed.addField(_.startCase(update.status) + timeString, update.body, false);
    }
    embed.fields.reverse();
    return embed;
}

async function getMessageIdFromIncident(id: string) {
    return (await readJsonFile())[id];
}

async function createMessage(incident: any) {
    const id = incident.id;
    const json = await readJsonFile();
    const messageId = await sendIncident(incident);
    json[id] = messageId;
    console.log(`Created new message for incident ${id} with message-id ${messageId}.`);
    fs.writeFileSync(fileName, JSON.stringify(json, null, 4));
}

async function fetchApi() {
    let res = await fetch(apiUrl);
    return await res.json();
}

async function start() {
    let obj = await fetchApi();

    let incidents = obj.incidents.reverse();
    for (let i in incidents) {
        let incident = incidents[i];
        try {
            await checkIncident(incident);
        } catch (e) {
            console.error("Could not check incident.", e);
        }
    }
}

async function sendIncident(incident: any) {
    const res = await webhookClient.send({
        embeds: [buildEmbed(incident)],
    });
    return res.id;
}

checkFile().then(() => start().then(() => console.log("Done.")).catch(console.error)).catch(console.error);
