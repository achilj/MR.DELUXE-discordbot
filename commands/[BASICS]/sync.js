const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionsBitField
} = require('discord.js');
const config = require('../../config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('sync')
        .setDescription('Synchroniseer slash commands met deze guild, of verwijder ze.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addBooleanOption(opt => opt
            .setName('clear')
            .setDescription('Als true: verwijder alle slash commands voor deze guild')
            .setRequired(false)
        )
        .addBooleanOption(opt => opt
            .setName('all')
            .setDescription('Als true: verwijder alle slash commands wereldwijd en in alle guilds')
            .setRequired(false)
        ),
    async execute(interaction) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            const embed = new EmbedBuilder()
                .setTitle('Geen toestemming')
                .setDescription('Je hebt Administrator rechten nodig om dit uit te voeren.')
                .setColor(config.general.color);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const clear = interaction.options.getBoolean('clear') || false;
        const client = interaction.client;

        try {
            if (!client.application) await client.fetchApplication();

            if (clear) {
                const all = interaction.options.getBoolean('all') || false;
                const scheduleRestart = (client) => {
                    setTimeout(async () => {
                        try {
                            await client.destroy();
                        } catch (e) {
                            console.error('Error destroying client before restart:', e);
                        } finally {
                            process.exit(1);
                        }
                    }, 1000);
                };
                if (all) {
                    // Verwijder globale commands
                    await client.application.commands.set([]);
                    // Verwijder guild-commands voor alle guilds waarin de bot zit
                    for (const [guildId] of client.guilds.cache) {
                        try {
                            await client.application.commands.set([], guildId);
                        } catch (e) {
                            console.error(`Kon commands niet wissen voor guild ${guildId}:`, e);
                        }
                    }
                    await interaction.editReply({ content: 'Alle slash commands wereldwijd en in alle guilds zijn verwijderd. Bot wordt herstart.' });
                    scheduleRestart(client);
                    return;
                }

                // Alleen huidige guild wissen
                await client.application.commands.set([], interaction.guildId);
                await interaction.editReply({ content: 'Alle slash commands voor deze guild zijn verwijderd. Bot wordt herstart.' });
                scheduleRestart(client);
                return;
            }

            // Synchroniseer: registreer alle ingeladen commando's voor deze guild
            const cmds = Array.from(client.commands.values())
                .map(c => (c.data && typeof c.data.toJSON === 'function') ? c.data.toJSON() : null)
                .filter(Boolean);

            await client.application.commands.set(cmds, interaction.guildId);
            return interaction.editReply({ content: `Gesynchroniseerd: ${cmds.length} commando(s) geregistreerd voor deze guild.` });
        } catch (err) {
            console.error('Fout bij sync/clear commands:', err);
            return interaction.editReply({ content: 'Fout bij synchroniseren/verwijderen van commands. Bekijk de logs.' });
        }
    }
};
