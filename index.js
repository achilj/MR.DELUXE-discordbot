require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Events, REST, Routes, EmbedBuilder, ActivityType } = require('discord.js');
const config = require('./config.js');
const { initDB, getPool } = require('./services/db');

// Services
const startTempbanChecker = require('./services/tempbanChecker');
const startGiveawayChecker = require('./services/giveawayChecker');
const registerLogHandlers = require('./services/logHandlers');
const registerWelcomeMessage = require('./services/welcomeMessage');
const startAntiNukeService = require('./services/antiNuke');
const startCheckinScheduler = require('./services/checkinScheduler');
const registerVerifyEmbed = require('./services/verifyEmbed');
const registerCounters = require('./services/counters');
const registerVoiceLogs = require('./services/voiceLogs');
const registerMiscLogs = require('./services/miscLogs');
const registerWeekDiscord = require('./services/weekDiscord');
const registerTicketPanel = require('./services/[TICKETS]/ticketEmbed');

(async function bootstrap() {
    // 1) DB eerst checken/bouwen
    await initDB();
    const pool = getPool();

    // 2) Discord bot setup
    const client = new Client({ 
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildVoiceStates
        ],
        partials: ['MESSAGE', 'CHANNEL'] // voor niet-gecachede berichten
    });
    client.commands = new Collection();
    const commands = [];

    registerLogHandlers(client, config);
    registerWelcomeMessage(client, config);
    startAntiNukeService(client, pool, config);
    startCheckinScheduler(client, pool);
    registerVerifyEmbed(client, config);
    registerCounters(client, config);
    registerVoiceLogs(client, config);
    registerMiscLogs(client, config);
    registerWeekDiscord(client, config);
    registerTicketPanel(client);

    // Alle command files ophalen
    function getAllCommandFiles(dir) {
        let results = [];
        const list = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of list) {
            const filePath = path.join(dir, file.name);
            if (file.isDirectory()) {
                results = results.concat(getAllCommandFiles(filePath));
            } else if (file.isFile() && file.name.endsWith('.js')) {
                results.push(filePath);
            }
        }
        return results;
    }

    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = getAllCommandFiles(commandsPath);

    const loadedCommands = [];
    for (const filePath of commandFiles) {
        const commandModule = require(filePath);
        const commandList = Array.isArray(commandModule.commands)
            ? commandModule.commands
            : (('data' in commandModule && 'execute' in commandModule) ? [commandModule] : []);

        for (const command of commandList) {
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
                commands.push(command.data.toJSON());
                loadedCommands.push(command.data.name);
            }
        }
        if (commandList.length === 0) {
            console.warn(`[WAARSCHUWING] Geen geldige command(s) in ${filePath}`);
        }
    }

    console.log('Gemaakt door AchilCraft');
    console.log(`Ingeladen commands: ${loadedCommands.length > 0 ? loadedCommands.join(', ') : 'geen'}`);

    // Slash commands registreren
    client.once(Events.ClientReady, async () => {
        console.log(`Ingelogd als ${client.user.tag}`);

        // Presence rotatie: elke 5s "Listening to 🎵 <status>"
        try {
            const list = Array.isArray(config.status.activities) ? config.status.activities.filter(s => typeof s === 'string' && s.trim().length > 0) : [];
            const statuses = list.length > 0 ? list : ['de server']; // Fallback indien lijst leeg/missing
            let lastIndex = -1; // Zodat die zeker nooit dezelfde twee keer na elkaar kiest

            const prefix = (typeof config.status.prefixEmoji === 'string' && config.status.prefixEmoji.trim()) ? config.status.prefixEmoji.trim() : '🎵';
            const setListening = () => {
                let idx;
                if (statuses.length === 1) {
                    idx = 0;
                } else {
                    do {
                        idx = Math.floor(Math.random() * statuses.length);
                    } while (idx === lastIndex);
                }
                lastIndex = idx;
                const raw = statuses[idx];
                const name = `${prefix} ${raw}`.trim();
                try {
                    client.user.setActivity({ name, type: ActivityType.Listening });
                } catch (err) {
                    console.error('Fout bij setActivity:', err);
                }
            };

            setListening();
            setInterval(setListening, 5000);
        } catch (presenceErr) {
            console.error('Kon de presence-rotatie niet starten:', presenceErr);
        }
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        try {
            console.log("Cached guilds:", client.guilds.cache.map(g => `${g.name} (${g.id})`));
            // Eerst ALLE bestaande commands verwijderen om conflicten te voorkomen
            if (process.env.GUILD_ID) {
                // Guild-commands opschonen
                const existingGuildCommands = await rest.get(
                    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
                );
                if (Array.isArray(existingGuildCommands) && existingGuildCommands.length > 0) {
                    console.log(`Oude guild commands gevonden (${existingGuildCommands.length}). Verwijderen...`);
                    for (const cmd of existingGuildCommands) {
                        try {
                            await rest.delete(
                                Routes.applicationGuildCommand(client.user.id, process.env.GUILD_ID, cmd.id)
                            );
                        } catch (delErr) {
                            console.error(`Kon guild command ${cmd.name} (${cmd.id}) niet verwijderen:`, delErr);
                        }
                    }
                    console.log('Alle oude guild commands verwijderd.');
                } else {
                    console.log('Geen oude guild commands gevonden.');
                }
            } else {
                // Globale commands opschonen
                const existingGlobalCommands = await rest.get(
                    Routes.applicationCommands(client.user.id)
                );
                if (Array.isArray(existingGlobalCommands) && existingGlobalCommands.length > 0) {
                    console.log(`Oude globale commands gevonden (${existingGlobalCommands.length}). Verwijderen...`);
                    for (const cmd of existingGlobalCommands) {
                        try {
                            await rest.delete(
                                Routes.applicationCommand(client.user.id, cmd.id)
                            );
                        } catch (delErr) {
                            console.error(`Kon globaal command ${cmd.name} (${cmd.id}) niet verwijderen:`, delErr);
                        }
                    }
                    console.log('Alle oude globale commands verwijderd.');
                } else {
                    console.log('Geen oude globale commands gevonden.');
                }
            }

            if (process.env.GUILD_ID) {
                await rest.put(
                    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
                    { body: commands }
                );
                const guild = client.guilds.cache.get(process.env.GUILD_ID);
                const guildName = guild ? guild.name : 'onbekend';
                console.log(`Slash commands geregistreerd voor guild: ${process.env.GUILD_ID} (${guildName})`);
            } else {
                await rest.put(
                    Routes.applicationCommands(client.user.id),
                    { body: commands }
                );
                console.log('Slash commands wereldwijd geregistreerd.');
            }
        } catch (error) {
            console.error('Fout bij registreren van slash commands:', error);
        }
    });

    // Interactie handler
    client.on(Events.InteractionCreate, async interaction => {
        if (interaction.isButton()) {
            for (const cmd of client.commands.values()) {
                if (typeof cmd.handleButton === 'function') {
                    try {
                        const handled = await cmd.handleButton(interaction, pool);
                        if (handled) return;
                    } catch (e) {
                        console.error('Fout in handleButton:', e);
                    }
                }
            }
        }
        if (interaction.isModalSubmit()) {
            for (const cmd of client.commands.values()) {
                if (typeof cmd.handleModal === 'function') {
                    try {
                        const handled = await cmd.handleModal(interaction, pool);
                        if (handled) return;
                    } catch (e) {
                        console.error('Fout in handleModal:', e);
                    }
                }
            }
        }
        if (interaction.isChatInputCommand() || interaction.isUserContextMenuCommand()) {
            if (!interaction.guild) {
                await interaction.reply({ 
                    embeds: [{
                        title: '🛑 DM-Commando\'s',
                        description: 'Ik kan geen commando\'s uitvoeren in DM! Gebruik mij in de server!',
                        color: 0xFF0000
                    }]
                });
                return;
            }
            const command = client.commands.get(interaction.commandName);
            if (!command) return;
            try {
                await command.execute(interaction, pool);
            } catch (error) {
                console.error(error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'Er is een fout opgetreden bij het uitvoeren van dit commando!', flags: 64 });
                } else {
                    await interaction.reply({ content: 'Er is een fout opgetreden bij het uitvoeren van dit commando!', flags: 64 });
                }
            }
        }
    });

    client.login(process.env.DISCORD_TOKEN);

    // Start checkers (na DB init)
    startTempbanChecker(client, pool, config);
    startGiveawayChecker(client, pool);
})();