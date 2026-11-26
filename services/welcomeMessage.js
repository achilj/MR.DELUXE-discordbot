const { EmbedBuilder } = require('discord.js');

module.exports = function registerWelcomeMessage(client, config) {
    client.on('guildMemberAdd', async member => {
        const channel = member.guild.channels.cache.get(config.welcome.channelId);
        if (!channel || !channel.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setTitle('👋 Welkom op de server!')
            .setDescription(`Welkom ${member.user.username}! Leuk dat je er bent.\nLees zeker even de regels door en stel jezelf voor!`)
            .setColor(config.general.color)
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setTimestamp();
        await channel.send({ content: member.toString(), embeds: [embed] });
    });
};