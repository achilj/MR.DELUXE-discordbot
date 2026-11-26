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
const BAN_LOG_CHANNEL_ID = config.logs.moderation.banChannelId;

function labelForDeleteSeconds(seconds) {
    const s = Number(seconds || 0);
    if (s <= 0) return 'geen';
    if (s === 3600) return 'afgelopen uur';
    if (s === 21600) return 'afgelopen zes uur';
    if (s === 43200) return 'afgelopen twaalf uur';
    if (s === 86400) return 'afgelopen één dag';
    if (s === 259200) return 'afgelopen drie dagen';
    if (s === 604800) return 'afgelopen zeven dagen';
    return `afgelopen ${Math.floor(s / 3600)} uur`;
}

// Gedeelde flow voor Slash en Context Menu
async function handleBanFlow(interaction, targetUser, opgegevenReden, deleteMessageSeconds, initialRespondFn) {
    const respond = initialRespondFn || interaction.reply.bind(interaction);

    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const isModerator = member.roles.cache.has(MODERATOR_ROLE_ID);
    if (!isAdmin && !isModerator) {
        return respond({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 });
    }

    if (!targetUser) {
        return respond({ content: 'Gebruiker niet gevonden. Selecteer een gebruiker of vul een geldige user ID, tag of mention in.', flags: 64 });
    }

    // Probeer guild member te fetchen (kan null zijn)
    let targetMember = null;
    try { targetMember = await interaction.guild.members.fetch(targetUser.id); } catch { targetMember = null; }

    // Check of target admin/mod is (alleen als member)
    if (targetMember) {
        const isTargetAdmin = targetMember.permissions.has(PermissionFlagsBits.Administrator);
        const isTargetModerator = targetMember.roles.cache.has(MODERATOR_ROLE_ID);
        if (isTargetAdmin || isTargetModerator) {
            const embed = new EmbedBuilder()
                .setTitle('Kan gebruiker niet bannen')
                .setDescription('Je kunt geen administrator of moderator bannen.')
                .setColor(0xFF0000);
            return respond({ embeds: [embed], flags: 64 });
        }
        if (!targetMember.bannable) {
            return respond({ content: 'Ik kan deze gebruiker niet bannen (mogelijk door rolhiërarchie of ontbrekende rechten).', flags: 64 });
        }
    }

    // Validatie deleteMessageSeconds
    const dms = Number(deleteMessageSeconds || 0);
    if (dms < 0 || dms > 604800) {
        return respond({ content: 'Ongeldige optie voor het verwijderen van berichten.', flags: 64 });
    }

    async function logBan(reason) {
        if (!BAN_LOG_CHANNEL_ID) return;
        try {
            const guild = interaction.guild;
            const logChannel = guild.channels.cache.get(BAN_LOG_CHANNEL_ID);
            if (logChannel && logChannel.isTextBased()) {
                const avatarUrl = typeof targetUser.displayAvatarURL === 'function'
                    ? targetUser.displayAvatarURL({ extension: 'png', size: 128 })
                    : null;

                const displayReason = reason && reason.trim().length > 0 ? reason : 'GEEN';

                const embed = new EmbedBuilder()
                    .setTitle('🛑 Gebruiker verbannen')
                    .setDescription([
                        `**User ID:**\n> \`${targetUser.id}\``,
                        `**Gebruiker:**\n> <@${targetUser.id}> (${targetUser.tag})`,
                        `**Verbannen door:**\n> <@${interaction.user.id}> (${interaction.user.tag})`,
                        `**Reden:**\n> ${displayReason}`
                    ].join('\n'))
                    .setColor(0xFF0000)
                    .setTimestamp(new Date());

                if (avatarUrl) {
                    embed.setThumbnail(avatarUrl);
                }

                await logChannel.send({ embeds: [embed] });
            }
        } catch (err) {
            console.error('[BanLog] Fout bij loggen van ban:', err);
        }
    }

    async function voerBanUit(reason, respondFn) {
        const deleteLabel = labelForDeleteSeconds(dms);
        try {
            // DM msg zodat de gebruiker weet dat die verbannen is
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle(`Je bent verbannen van ${interaction.guild.name}`)
                    .setDescription(`**Reden:** ${reason}`)
                    .setColor(EMBED_COLOR);
                await targetUser.send({ embeds: [dmEmbed] });
            } catch {
                if (targetUser.tag) console.warn(`Kon geen DM sturen naar ${targetUser.tag}.`);
            }

            // Probeer eerst als member te bannen (voor message delete)
            if (targetMember) {
                await targetMember.ban({
                    reason: `${reason} (door ${interaction.user.tag})`,
                    deleteMessageSeconds: dms
                });
            } else {
                // Als geen member, ban via guild.bans.create
                await interaction.guild.bans.create(targetUser.id, {
                    reason: `${reason} (door ${interaction.user.tag})`,
                    deleteMessageSeconds: dms
                });
            }

            const embed = new EmbedBuilder()
                .setTitle(`🛑 ${targetUser.tag || targetUser.id} werd succesvol verbannen!`)
                .setDescription(`**Reden:** ${reason}\n**Berichten verwijderd:** ${deleteLabel}`)
                .setColor(EMBED_COLOR);
            await respondFn({ embeds: [embed], flags: 64 });

            await logBan(reason);

            // Meld aan Anti‑Nuke dat een ban is uitgevoerd door deze uitvoerder
            try {
                interaction.client.emit('antiNuke:modAction', {
                    guildId: interaction.guild.id,
                    executorId: interaction.user.id,
                    type: 'memberBan'
                });
            } catch {}
        } catch (err) {
            console.error(err);
            await respondFn({ content: 'Kon de gebruiker niet bannen. Mogelijk heb ik niet genoeg rechten of is de gebruiker al verbannen.', flags: 64 });
        }
    }

    // Als er al een reden is mag deze meteen gebanned worden, anders modal tonen
    if (opgegevenReden && opgegevenReden.trim() !== '') {
        return voerBanUit(opgegevenReden, respond);
    }

    // Anders → modal tonen
    const modal = new ModalBuilder()
        .setCustomId(`ban-modal-${targetUser.id}-${interaction.user.id}`)
        .setTitle(`Ban ${targetUser.tag}`)
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder({
                custom_id: 'ban-reason',
                label: 'Reden voor ban',
                style: TextInputStyle.Paragraph,
                placeholder: 'Vul hier de reden in...',
                required: true
            })
        ));

    await interaction.showModal(modal);

    // Wacht op de modal
    const filter = i => i.customId === `ban-modal-${targetUser.id}-${interaction.user.id}` && i.user.id === interaction.user.id;
    interaction.client.once('interactionCreate', async modalInteraction => {
        if (!modalInteraction.isModalSubmit()) return;
        if (!filter(modalInteraction)) return;
        const reason = modalInteraction.fields.getTextInputValue('ban-reason');
        await voerBanUit(reason, modalInteraction.reply.bind(modalInteraction));
    });
}

// Slash ban command (behoud bestaande keuzes)
const slashBan = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban een gebruiker met een reden (alleen voor moderators/admins)')
        .addUserOption(option =>
            option.setName('gebruiker')
                .setDescription('Selecteer een gebruiker (autocomplete)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('reden')
                .setDescription('Reden voor de ban (optioneel, als ingevuld wordt geen popup getoond)')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('verwijder_berichten')
                .setDescription('Welke berichten van de gebruiker moeten verwijderd worden?')
                .setRequired(false)
                .addChoices(
                    { name: 'Verwijder geen berichten', value: '0' },
                    { name: 'Afgelopen uur', value: '3600' },
                    { name: 'Afgelopen 6 uur', value: '21600' },
                    { name: 'Afgelopen 12 uur', value: '43200' },
                    { name: 'Afgelopen 24 uur', value: '86400' },
                    { name: 'Afgelopen 3 dagen', value: '259200' },
                    { name: 'Afgelopen 7 dagen', value: '604800' }
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('gebruiker');
        const opgegevenReden = interaction.options.getString('reden') || '';
        const deleteMessageSeconds = Number(interaction.options.getString('verwijder_berichten') || 0);
        await handleBanFlow(interaction, targetUser, opgegevenReden, deleteMessageSeconds, interaction.reply.bind(interaction));
    }
};

// Context menu ban command (altijd: geen berichten verwijderen)
const contextBan = {
    data: new ContextMenuCommandBuilder()
        .setName('Ban')
        .setType(ApplicationCommandType.User)
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
        const targetUser = interaction.targetUser;
        // Bij context menu: geen berichten verwijderen (0) en reden via modal
        await handleBanFlow(interaction, targetUser, '', 0, interaction.reply.bind(interaction));
    }
};

module.exports = { commands: [slashBan, contextBan] };
