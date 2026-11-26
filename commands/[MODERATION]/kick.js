const {
    SlashCommandBuilder,
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder
} = require('discord.js');
const config = require('../../config.js');
const MODERATOR_ROLE_ID = config.roles.moderatorId;
const EMBED_COLOR = config.general.color;
const KICK_LOG_CHANNEL_ID = config.logs.moderation.kickChannelId;

const resolveConfigColor = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const normalized = value.startsWith('#') ? value.slice(1) : value;
        const parsed = parseInt(normalized, 16);
        return Number.isNaN(parsed) ? 0x5865F2 : parsed;
    }
    return 0x5865F2;
};

const RESOLVED_EMBED_COLOR = resolveConfigColor(EMBED_COLOR);

const getAvatarUrl = (user) => {
    try {
        if (!user) return null;
        return user.displayAvatarURL({ extension: 'png', size: 128 }) || null;
    } catch {
        return null;
    }
};
// Gedeelde kick-flow
async function handleKickFlow(interaction, targetUser, opgegevenReden, initialRespondFn) {
    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const isModerator = member.roles.cache.has(MODERATOR_ROLE_ID);
    if (!isAdmin && !isModerator) {
        return initialRespondFn
            ? initialRespondFn({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 })
            : interaction.reply({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 });
    }

    if (!targetUser) {
        return (initialRespondFn || interaction.reply.bind(interaction))({ content: 'Gebruiker niet gevonden.', flags: 64 });
    }

    // Vind guild member
    let targetMember = null;
    try { targetMember = await interaction.guild.members.fetch(targetUser.id); } catch { targetMember = null; }
    if (!targetMember) {
        return (initialRespondFn || interaction.reply.bind(interaction))({ content: 'Deze gebruiker zit niet (meer) in de server.', flags: 64 });
    }

    // Bescherm staff
    if (targetMember.permissions.has(PermissionFlagsBits.Administrator) || targetMember.roles.cache.has(MODERATOR_ROLE_ID)) {
        const embed = new EmbedBuilder()
            .setTitle('Kan gebruiker niet kicken')
            .setDescription('Je kunt geen administrator of moderator kicken.')
            .setColor(0xFF0000);
        return (initialRespondFn || interaction.reply.bind(interaction))({ embeds: [embed], flags: 64 });
    }

    // Bot kan kicken?
    if (!targetMember.kickable) {
        return (initialRespondFn || interaction.reply.bind(interaction))({ content: 'Ik kan deze gebruiker niet kicken (mogelijk door rolhiërarchie of ontbrekende rechten).', flags: 64 });
    }

    // Log naar kick-log
    async function logKick(reason) {
        if (!KICK_LOG_CHANNEL_ID) return;
        try {
            const logChannel = interaction.guild.channels.cache.get(KICK_LOG_CHANNEL_ID);
            if (logChannel && logChannel.isTextBased()) {
                const targetTag = targetUser.tag || targetUser.username || 'Onbekend';
                const executorTag = interaction.user?.tag || interaction.user?.username || 'Onbekend';
                const embed = {
                    title: '🚪 Gebruiker gekickt',
                    description: [
                        `**User ID:**\n> \`${targetUser.id}\``,
                        `**Gebruiker:**\n> <@${targetUser.id}> (${targetTag})`,
                        `**Gekickt door:**\n> <@${interaction.user.id}> (${executorTag})`,
                        `**Reden:**\n> ${reason || 'Geen reden opgegeven'}`
                    ].join('\n'),
                    color: RESOLVED_EMBED_COLOR,
                    timestamp: new Date().toISOString(),
                    thumbnail: { url: getAvatarUrl(targetUser) }
                };

                await logChannel.send({ embeds: [embed] });
            }
        } catch (err) {
            console.error('[KickLog] Fout bij loggen van kick:', err);
        }
    }

    // Voer kick uit
    async function voerKickUit(reason, respondFn) {
        try {
            // DM notificatie
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle(`Je bent gekickt uit ${interaction.guild.name}`)
                    .setDescription(`**Reden:** ${reason || 'Geen reden opgegeven'}`)
                    .setColor(RESOLVED_EMBED_COLOR);
                await targetUser.send({ embeds: [dmEmbed] });
            } catch {
                if (targetUser.tag) console.warn(`Kon geen DM sturen naar ${targetUser.tag}.`);
            }

            // Kick
            await targetMember.kick(`${reason || 'Geen reden opgegeven'} (door ${interaction.user.tag})`);

            const replyEmbed = new EmbedBuilder()
                .setTitle(`🚪 ${targetUser.tag || targetUser.id} is gekickt`)
                .setDescription(`**Reden:** ${reason || 'Geen reden opgegeven'}`)
                .setColor(RESOLVED_EMBED_COLOR);
            await respondFn({ embeds: [replyEmbed], flags: 64 });

            await logKick(reason);

            // Meld aan Anti‑Nuke dat een kick is uitgevoerd door deze uitvoerder
            try {
                interaction.client.emit('antiNuke:modAction', {
                    guildId: interaction.guild.id,
                    executorId: interaction.user.id,
                    type: 'memberKick'
                });
            } catch {}
        } catch (err) {
            console.error(err);
            await respondFn({ content: 'Kon de gebruiker niet kicken. Mogelijk heb ik niet genoeg rechten.', flags: 64 });
        }
    }

    // Als reden opgegeven, direct uitvoeren
    if (opgegevenReden) {
        return voerKickUit(opgegevenReden, initialRespondFn || interaction.reply.bind(interaction));
    }

    // Vraag reden (modal)
    const modal = new ModalBuilder()
        .setCustomId(`kick-modal-${targetUser.id}-${interaction.user.id}`)
        .setTitle(`Kick ${targetUser.tag}`)
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder({
                custom_id: 'kick-reason',
                label: 'Reden voor kick',
                style: TextInputStyle.Paragraph,
                placeholder: 'Vul hier de reden in...',
                required: true
            })
        ));

    await interaction.showModal(modal);

    // Filter en afhandeling
    const filter = i => i.customId === `kick-modal-${targetUser.id}-${interaction.user.id}` && i.user.id === interaction.user.id;
    interaction.client.once('interactionCreate', async modalInteraction => {
        if (!modalInteraction.isModalSubmit()) return;
        if (!filter(modalInteraction)) return;
        const reason = modalInteraction.fields.getTextInputValue('kick-reason');
        await voerKickUit(reason, modalInteraction.reply.bind(modalInteraction));
    });
}

// Slash-commando
const slashKick = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick een gebruiker met reden (alleen voor moderators/admins)')
        .addUserOption(option =>
            option.setName('gebruiker')
                .setDescription('Selecteer een gebruiker (autocomplete)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reden')
                .setDescription('Reden voor de kick (optioneel, als ingevuld wordt geen popup getoond)')
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('gebruiker');
        const opgegevenReden = (interaction.options.getString('reden') || '').trim();
        await handleKickFlow(interaction, targetUser, opgegevenReden, interaction.reply.bind(interaction));
    }
};

// Contextmenu-commando
const contextKick = {
    data: new ContextMenuCommandBuilder()
        .setName('Kick')
        .setType(ApplicationCommandType.User)
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction) {
        const targetUser = interaction.targetUser;
        await handleKickFlow(interaction, targetUser, '', interaction.reply.bind(interaction));
    }
};

module.exports = { commands: [slashKick, contextKick] };