const { 
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const config = require('../../config.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Controleer of de bot reageert en bekijk de latency.'),
    async execute(interaction) {
        const latency = Date.now() - interaction.createdTimestamp;
        const embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
        const embed = new EmbedBuilder()
            .setTitle('🏓 Pong!')
            .setDescription(`De latentie is **${latency} ms**.`)
            .setColor(embedColor)

    await interaction.reply({ embeds: [embed], flags: 64 });
    },
};