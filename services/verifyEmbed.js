const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, Events } = require('discord.js');

// Lokale state voor challenges
const stateByToken = new Map();

// Config-onafhankelijke helpers
const CATEGORIES = ['dieren', 'voertuigen'];
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => arr.sort(() => Math.random() - 0.5);
const token = () => Math.random().toString(36).slice(2, 10);

module.exports = function registerVerifyEmbed(client, config) {
    const VERIFICATION_CHANNEL_ID = config.verification.channelId;
    const VERIFICATION_LOG_CHANNEL_ID = config.verification.logChannelId;
    const MEMBER_ROLE_ID = config.roles.memberId;
    const EMBED_COLOR = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;

    if (!VERIFICATION_CHANNEL_ID) {
        console.warn('[Verify] Geen verification.channelId in config.js');
        return;
    }

    function loadCategoryFiles(category) {
        const base = path.join(__dirname, 'verifyimg', category);
        let files = [];
        try { files = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { files = []; }
        return files
            .filter(d => d.isFile() && IMG_EXT.has(path.extname(d.name).toLowerCase()))
            .map(d => {
                const name = path.basename(d.name, path.extname(d.name));
                return {
                    name,
                    fileName: d.name,
                    absPath: path.join(base, d.name)
                };
            });
    }

    async function ensureChannel() {
        const ch = client.channels.cache.get(VERIFICATION_CHANNEL_ID) || await client.channels.fetch(VERIFICATION_CHANNEL_ID).catch(() => null);
        return (ch && ch.isTextBased()) ? ch : null;
    }

    async function ensureLogChannel() {
        if (!VERIFICATION_LOG_CHANNEL_ID) return null;
        const ch = client.channels.cache.get(VERIFICATION_LOG_CHANNEL_ID) || await client.channels.fetch(VERIFICATION_LOG_CHANNEL_ID).catch(() => null);
        return (ch && ch.isTextBased()) ? ch : null;
    }

    async function startChallenge(interaction) {
        const guild = interaction.guild;
        const member = interaction.member;
        if (!guild || !member) {
            return interaction.reply({ content: 'Dit werkt alleen in een server.', flags: 64 });
        }
        if (!MEMBER_ROLE_ID) {
            return interaction.reply({ content: 'Member rol niet geconfigureerd.', flags: 64 });
        }
        if (member.roles.cache.has(MEMBER_ROLE_ID)) {
            return interaction.reply({ content: 'Je bent al geverifieerd.', flags: 64 });
        }

        // Kanaal valideren - niet strikt nodig voor ephemerals, maar check is ok
        await ensureChannel();

        // Kies categorie en laad bestanden
        let category = pickRandom(CATEGORIES);
        let files = loadCategoryFiles(category);
        if (files.length < 5) {
            const other = CATEGORIES.find(c => c !== category);
            const otherFiles = loadCategoryFiles(other);
            if (otherFiles.length >= 5) {
                category = other;
                files = otherFiles;
            }
        }
        if (files.length < 5) {
            return interaction.reply({ content: 'Er zijn onvoldoende afbeeldingen om te verifiëren. Voeg minimaal 5 afbeeldingen per categorie toe.', flags: 64 });
        }

        const correct = pickRandom(files);
        const pool = shuffle(files.filter(f => f.name !== correct.name)).slice(0, 4);
        const options = shuffle([correct.name, ...pool.map(p => p.name)]).slice(0, 5);

        const t = token();
        const rows = [
            new ActionRowBuilder().addComponents(
                ...options.map((opt, idx) =>
                    new ButtonBuilder()
                        .setCustomId(`verify-ans|${t}|${idx}`)
                        .setLabel(opt)
                        .setStyle(ButtonStyle.Primary)
                )
            )
        ];

        const embed = new EmbedBuilder()
            .setTitle('🔎 Verificatie')
            .setDescription('Kies de juiste naam die hoort bij de afbeelding hieronder.')
            .setImage(`attachment://${correct.fileName}`)
            .setColor(EMBED_COLOR || 0x2b2d31);

        const payload = {
            embeds: [embed],
            components: rows,
            files: [{ attachment: correct.absPath, name: correct.fileName }],
            flags: 64 // ephemeral
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload);
        } else {
            await interaction.reply(payload);
        }

        stateByToken.set(t, {
            userId: interaction.user.id,
            category,
            correctName: correct.name,
            options
        });
    }

    async function handleAnswer(interaction, parts) {
        const tok = parts[1];
        const idx = Number(parts[2] || -1);
        const st = stateByToken.get(tok);
        if (!st) {
            return interaction.reply({ content: 'Deze verificatie is verlopen. Start opnieuw via de knop.', flags: 64 });
        }
        if (interaction.user.id !== st.userId) {
            return interaction.reply({ content: 'Dit is niet jouw verificatie.', flags: 64 });
        }
        const chosen = st.options[idx];
        const isCorrect = chosen === st.correctName;

        const member = interaction.member;

        stateByToken.delete(tok);

        if (isCorrect) {
            try {
                if (!member.roles.cache.has(MEMBER_ROLE_ID)) {
                    await member.roles.add(MEMBER_ROLE_ID, 'Verificatie geslaagd');
                }
            } catch (_) {}

            const successEmbed = new EmbedBuilder()
                .setTitle('✅ Verificatie geslaagd')
                .setDescription('Je hebt toegang gekregen.')
                .setColor(0x57F287);

            return interaction.update({ embeds: [successEmbed], components: [] });
        } else {
            const failEmbed = new EmbedBuilder()
                .setTitle('❌ Verificatie mislukt')
                .setDescription('Helaas, fout antwoord. Probeer opnieuw via de knop.')
                .setColor(0xFF0000);

            try {
                const logChannel = await ensureLogChannel();
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setTitle('❌ Verificatie mislukt')
                        .setDescription([
                            `**Gebruiker:** <@${interaction.user.id}> (${interaction.user.tag})`,
                            `**Categorie:** ${st.category}`,
                            `**Gekozen:** ${chosen || '—'}`,
                            `**Correct:** ${st.correctName}`
                        ].join('\n'))
                        .setColor(0xFF0000)
                        .setTimestamp(new Date());
                    await logChannel.send({ embeds: [logEmbed] });
                }
            } catch (_) {}

            return interaction.update({ embeds: [failEmbed], components: [] });
        }
    }

    // Plaats of valideer de verify-embed bij opstart
    client.once(Events.ClientReady, async () => {
        try {
            const channel = await ensureChannel();
            if (!channel) {
                console.warn('[Verify] Verificatiekanaal niet gevonden of niet tekstueel.');
                return;
            }

            // Bestaat er al een verify-bericht met de juiste knop?
            let exists = false;
            try {
                const messages = await channel.messages.fetch({ limit: 50 });
                exists = messages.some(m =>
                    m.author?.id === client.user.id &&
                    m.components?.some(row =>
                        row.components?.some(c => c.customId === 'verify_start')
                    )
                );
            } catch (_) {}

            if (exists) {
                console.log('[Verify] Bestaand verify-embed gevonden. Geen nieuwe geplaatst.');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('✅ Verificatie vereist')
                .setDescription([
                    'Welkom! Klik op de onderstaande knop om te bevestigen dat je een echte gebruiker bent en akkoord gaat met de serverregels. Je krijgt een afbeelding te zien met vijf mogelijke antwoorden, kies de juiste naam om toegang te krijgen.'
                ].join('\n'))
                .setColor(EMBED_COLOR || 0x2b2d31);

            const startBtn = new ButtonBuilder()
                .setCustomId('verify_start')
                .setLabel('Verifiëren')
                .setStyle(ButtonStyle.Success);

            const row = new ActionRowBuilder().addComponents(startBtn);
            await channel.send({ embeds: [embed], components: [row] });
            console.log('[Verify] Verify-embed geplaatst in verificatiekanaal.');
        } catch (err) {
            console.error('[Verify] Fout bij plaatsen/checken verify-embed:', err);
        }
    });

    // Interactie-afhandeling voor verificatieknoppen
    client.on(Events.InteractionCreate, async interaction => {
        try {
            if (!interaction.isButton()) return;
            const id = interaction.customId || '';
            if (id === 'verify_start') {
                return startChallenge(interaction);
            }
            if (id.startsWith('verify-ans|')) {
                const parts = id.split('|');
                if (parts.length === 3) {
                    return handleAnswer(interaction, parts);
                }
            }
        } catch (e) {
            console.error('[Verify] Fout in interactie-afhandeling:', e);
            if (!interaction.replied && !interaction.deferred) {
                try { await interaction.reply({ content: 'Er ging iets mis bij de verificatie.', flags: 64 }); } catch (_) {}
            }
        }
    });
};