const { 
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');
const config = require('../../config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Verwijder een aantal berichten in het huidige kanaal (alleen voor moderators/admins)')
        .addIntegerOption(option =>
            option.setName('aantal')
                .setDescription('Aantal berichten om te verwijderen (maximaal 100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        const amount = interaction.options.getInteger('aantal');

        // Probeer berichten te verwijderen
        try {
            const deletedMessages = await interaction.channel.bulkDelete(amount, true);
            const embed = new EmbedBuilder()
                .setTitle('🧹 Berichten Verwijderd')
                .setDescription(`Er zijn **${deletedMessages.size}** berichten verwijderd uit dit kanaal.`)
                .setColor(config.general.color)

            await interaction.reply({ embeds: [embed], flags: 64 });
        } catch (error) {
            console.error('Fout bij het verwijderen van berichten:', error);
            const errorMsg = 'Er is een fout opgetreden bij het verwijderen van berichten. Zorg ervoor dat de berichten niet ouder zijn dan 14 dagen.';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: errorMsg, flags: 64 });
            } else {
                await interaction.reply({ content: errorMsg, flags: 64 });
            }
        }
    },
};