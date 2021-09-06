import fetch from 'node-fetch';
import * as fs from "fs";
import {ColorResolvable, DiscordAPIError, MessageEmbed, WebhookClient} from "discord.js";
import {time} from "@discordjs/builders";
import * as config from "./config.json";
const _ = require("lodash");

const apiUrl = "https://discordstatus.com/api/v2/incidents.json";
const cacheFileName = "./messages.json";

const ignoreDays = config["ignoreDays"]??30;
const ignoreTime = ignoreDays * 86400000;
console.log(`Ignoring incidents from ${ignoreDays} days ago (${ignoreTime} ms).`);

const webhookClient = new WebhookClient({url: config.url});

/**
 * Checks if a message exists for the given incident. If so, the message will be updated, if there are new updates to
 * the given incident. If there is no message for the given incident, this method will create a new one.
 * @param incident - The incident to check
 */
async function checkIncident(incident: any) {
    let id = incident.id;
    const incidentUpdate = Date.parse(incident.updated_at);

    // check if update is too old
    if (Date.now() - incidentUpdate > ignoreTime) {
        console.debug(`Skipping update of incident ${id} because it's too old.`);
        return;
    }

    // check if message exists, if not create a new one
    let messageId = await getMessageIdOfIncident(id);
    if (messageId === undefined) {
        await createMessage(incident);
        return;
    }

    // fetch the old message
    let message = undefined;
    try {
        message = await webhookClient.fetchMessage(messageId);
    } catch (e) {
        // message most likely was deleted - send a new one
        if (e === DiscordAPIError) {
            await createMessage(incident);
            return;
        }
    }

    // message does not exist anymore - send a new one
    if (message === undefined) {
        await createMessage(incident);
        return;
    }

    // check timestamps in footer of embed to determine if we should update
    if (message.embeds.length > 0) {
        const messageUpdate = Date.parse(message.embeds[0].timestamp);
        const diff = messageUpdate - incidentUpdate;
        if (diff !== 0) {
            await updateMessage(message, incident);
            return;
        }
    } else {
        // message contains no embeds - update message
        await updateMessage(message, incident);
    }
}

/**
 * Creates a new EmbedMessage containing the information about the given incident.
 * @param incident
 * @return {MessageEmbed} - the newly constructed EmbedMessage
 */
function buildIncidentEmbed(incident: any) : MessageEmbed {
    const embed = new MessageEmbed()
        .setTitle(incident.name)
        .setURL(incident.shortlink)
        .setColor(getStatusColor(incident.status))
        .setFooter(incident.id)
        .setTimestamp(incident.updated_at);

    // collect affected components
    let components = [];
    for (let i in incident.components) {
        let component = incident.components[i];
        components.push(component.name);
    }

    embed.setDescription(`• Impact: ${incident.impact}\n• Affected Components: ${components.join(", ")}`);

    // collect incident updates
    for (let i in incident.incident_updates) {
        let update = incident.incident_updates[i];
        let timeString = " (" + time(new Date(update.created_at), "R") + ")";
        embed.addField(_.startCase(update.status) + timeString, update.body, false);
    }
    embed.fields.reverse();
    return embed;
}

/**
 * Creates a new message with the information about the given incident and stores the message id into the
 * cache file.
 * @param incident - The incident the message should represent
 */
async function createMessage(incident: any) {
    const id = incident.id;
    const json = await readMessagesFile();
    const messageId = await sendIncident(incident);
    json[id] = messageId;
    console.log(`Created new message for incident ${id} with message-id ${messageId}.`);
    fs.writeFileSync(cacheFileName, JSON.stringify(json, null, 4));
}

/**
 * Updates a given message with new information about the given incident.
 * @param message - The message to update
 * @param incident - The incident the message contains
 */
async function updateMessage(message, incident: any) {
    let id = incident.id;
    console.log(`Updating message of incident ${id}.`);
    await webhookClient.editMessage(message, {
        embeds: [buildIncidentEmbed(incident)],
    });
}

/**
 * Runs the checks for updated incidents.
 */
async function start() {
    let obj = await fetchIncidents();

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

/**
 * Sends a new message with the information of the given incident.
 * @param incident - The incident the message should represent
 * @return {String} id - The id of the newly created message
 */
async function sendIncident(incident: any) {
    const res = await webhookClient.send({
        embeds: [buildIncidentEmbed(incident)],
    });
    return res.id;
}

/**
 * Checks if the message cache file exists. If not it will create a new one.
 */
async function checkFile() {
    if (fs.existsSync(cacheFileName)) return;
    fs.writeFileSync(cacheFileName, JSON.stringify({}));
}

/**
 * Reads the message cache file and returns its contents as json.
 */
async function readMessagesFile() {
    const data = fs.readFileSync(cacheFileName, "utf-8");
    return JSON.parse(data);
}

/**
 * Finds the message id of the incident message, stored in the cache file.
 * @param {String} id - The id of an incident
 * @return {String | undefined} - The message id or undefined if it was not cached
 */
async function getMessageIdOfIncident(id: string) {
    return (await readMessagesFile())[id];
}

/**
 * Fetches the discord-status api and returns the result as json.
 */
async function fetchIncidents() {
    let res = await fetch(apiUrl);
    return await res.json();
}

/**
 * Gets a color for the status of an incident.
 * @param {String} status - The status of an incident
 * @return {ColorResolvable} color - The color corresponding to the given status
 */
function getStatusColor(status: string) : ColorResolvable {
    switch (status) {
        case "resolved": return "#06a51b";
        case "monitoring": return "#a3a506";
        case "identified": return "#a55806";
    }
    return "#a50626";
}

// check if the message cache file exists, then start the program
checkFile().then(() => start().then(() => console.log("Done.")).catch(console.error)).catch(console.error);
