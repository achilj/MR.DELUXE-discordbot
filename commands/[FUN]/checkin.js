const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType
} = require('discord.js');
const config = require('../../config.js');
const { logCheckinSuccess, logCheckinWrongWord, logCheckinMissed } = require('../../services/checkinLogs');

const EMBED_COLOR = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
const MODERATOR_ROLE_ID = config.roles.moderatorId;

function isModOrAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator) || member.roles.cache.has(MODERATOR_ROLE_ID);
}

function isAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
}

// optionele sessienaam kolom autodetectie
let SESSION_NAME_COL = null;
let SESSION_NAME_CHECKED = false;
async function ensureSessionNameSupport(pool) {
    if (SESSION_NAME_CHECKED) return SESSION_NAME_COL;
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkin_session' 
               AND COLUMN_NAME IN ('name','session_name') LIMIT 1`
        );
        SESSION_NAME_COL = rows.length ? rows[0].COLUMN_NAME : null;
    } catch (_) {
        SESSION_NAME_COL = null;
    } finally {
        SESSION_NAME_CHECKED = true;
    }
    return SESSION_NAME_COL;
}

function getSessionDisplayName(session) {
    if (!session) return null;
    if (SESSION_NAME_COL && session[SESSION_NAME_COL]) return session[SESSION_NAME_COL];
    return null;
}

async function getActiveSession(pool, guildId) {
    const [rows] = await pool.query(
        'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 1 LIMIT 1',
        [guildId]
    );
    return rows[0] || null;
}

async function getCurrentRound(pool, sessionId) {
    const [rows] = await pool.query(
        'SELECT * FROM checkin_round WHERE session_id = ? ORDER BY round_number DESC LIMIT 1',
        [sessionId]
    );
    return rows[0] || null;
}

// actieve ronde via session.active_round
async function getActiveRound(pool, sessionId) {
    const [[session]] = await pool.query(
        'SELECT active_round FROM checkin_session WHERE id = ?',
        [sessionId]
    );
    if (!session || !session.active_round) return null;
    const [rows] = await pool.query(
        'SELECT * FROM checkin_round WHERE session_id = ? AND round_number = ? LIMIT 1',
        [sessionId, session.active_round]
    );
    return rows[0] || null;
}

async function getSessionById(pool, guildId, sessionId) {
    const [rows] = await pool.query(
        'SELECT * FROM checkin_session WHERE guild_id = ? AND id = ? LIMIT 1',
        [guildId, sessionId]
    );
    return rows[0] || null;
}

async function getLatestSession(pool, guildId) {
    const [rows] = await pool.query(
        'SELECT * FROM checkin_session WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1',
        [guildId]
    );
    return rows[0] || null;
}

function formatPercent(part, total) {
    if (!total) return '0.00%';
    return `${((part / total) * 100).toFixed(2)}%`;
}

function embedSection(label, value) {
    return `**${label}:**\n> ${value}`;
}

function embedSections(...sections) {
    return sections.filter(Boolean).join('\n');
}

function nextAlignedMinute(minute, fromDate = null) {
    const now = fromDate ? new Date(fromDate) : new Date();
    const base = new Date(now);
    base.setSeconds(0, 0);
    base.setMinutes(minute);
    if (base <= now) base.setHours(base.getHours() + 1);
    return base;
}

function getLateJoinBlockReason(player, session, round) {
    if (player) return null;

    const currentRound = round?.round_number || 0;
    if (currentRound <= 1) return null;

    if (!session.allow_late_join_after_round1_reset) {
        return 'missed_round_one';
    }

    // Na reset van ronde 1 mag instromen alleen in ronde 2.
    if (currentRound === 2) return null;

    return 'round_two_closed';
}

function buildLosersEmbed(losers, page, perPage, totalPages, totalRounds, sessionName) {
    const start = page * perPage;
    const end = Math.min(start + perPage, losers.length);
    const slice = losers.slice(start, end);

    const lines = slice.map((row, i) => {
        const rank = start + i + 1;
        const reason = row.eliminated_reason === 'wrong' ? '❌ Fout woord' : '⏰ Gemist';
        return `**#${rank}** — <@${row.user_id}> — ${row.total_checkins}/${totalRounds} — ${reason}`;
    });

    return new EmbedBuilder()
        .setTitle(`💀 Afgevallen spelers${sessionName ? ` — ${sessionName}` : ''}`)
        .setDescription(lines.join('\n'))
        .setColor(EMBED_COLOR)
        .setFooter({ text: `Pagina ${page + 1}/${totalPages} • ${losers.length} afgevallen spelers` });
}

function buildLeaderboardEmbed(players, page, perPage, totalPages, totalRounds, sessionName, isEnded = false) {
    const start = page * perPage;
    const end = Math.min(start + perPage, players.length);
    const slice = players.slice(start, end);

    const lines = slice.map((row, i) => {
        const rank = start + i + 1;
        const status = row.eliminated ? ' 💀' : ' ✅';
        return `**#${rank}** — <@${row.user_id}> — ${row.total_checkins}/${totalRounds}${status}`;
    });

    const title = isEnded 
        ? `🏁 Checkin‑sessie beëindigd${sessionName ? ` — ${sessionName}` : ''}`
        : `🏆 Leaderboard${sessionName ? ` — ${sessionName}` : ''}`;

    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(lines.join('\n'))
        .setColor(EMBED_COLOR)
        .setFooter({ text: `Pagina ${page + 1}/${totalPages} • ${players.length} spelers` })
        .setTimestamp(isEnded ? new Date() : null);
}

function buildPaginationRow(prefix, sessionId, page, totalPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}_prev_${sessionId}_${page}`)
            .setLabel('◀ Vorige')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}_next_${sessionId}_${page}`)
            .setLabel('Volgende ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1)
    );
}

async function finalizePreviousRoundAndEliminateMisses(pool, sessionId, prevRoundId, guild = null, sessionName = null) {
    if (!prevRoundId) return;

    const [[round]] = await pool.query(
        'SELECT round_number, word FROM checkin_round WHERE id = ? LIMIT 1',
        [prevRoundId]
    );

    const [missedRows] = await pool.query(
        `
        SELECT p.user_id
        FROM checkin_player p
        LEFT JOIN checkin_entry e
          ON e.session_id = p.session_id
         AND e.round_id = ?
         AND e.user_id = p.user_id
         AND e.is_correct = 1
        WHERE p.session_id = ?
          AND p.eliminated = 0
          AND e.id IS NULL
        `,
        [prevRoundId, sessionId]
    );

    // elimineer misses vorige ronde
    await pool.query(
        `
        UPDATE checkin_player p
        LEFT JOIN checkin_entry e
          ON e.session_id = p.session_id
         AND e.round_id = ?
         AND e.user_id = p.user_id
         AND e.is_correct = 1
        SET 
          p.eliminated = 1,
          p.eliminated_reason = 'missed',
          p.eliminated_at = NOW()
        WHERE p.session_id = ?
          AND p.eliminated = 0
          AND e.id IS NULL
        `,
        [prevRoundId, sessionId]
    );

    if (guild && round && missedRows.length) {
        for (const row of missedRows) {
                        logCheckinMissed({
                guild,
                userId: row.user_id,
                roundNumber: round.round_number,
                word: round.word,
                sessionName
                        }).catch((err) => {
                                console.error('[Checkin] logCheckinMissed failed:', err);
                        });
        }
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('checkin')
        .setDescription('Check‑in spel voor 24u streams.')
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sc =>
            sc.setName('create')
                .setDescription('Maak een nieuwe checkin‑sessie aan (mods/admins)')
                .addStringOption(o =>
                        o.setName('naam')
                            .setDescription('Naam van de sessie (voor overzicht)')
                            .setRequired(true)
                )
        )
        .addSubcommand(sc =>
            sc.setName('start')
              .setDescription('Start de aangemaakte checkin‑sessie')
        )
        .addSubcommand(sc =>
            sc.setName('resetround')
              .setDescription('Reset een specifieke ronde (afgevallen gebruikers mogen weer meedoen)')
              .addIntegerOption(o =>
                  o.setName('ronde')
                   .setDescription('Het rondenummer om te resetten')
                   .setRequired(true)
              )
              .addStringOption(o =>
                  o.setName('woord')
                   .setDescription('Optioneel: nieuw woord voor deze ronde')
              )
        )
                // ADDWORD
        .addSubcommand(sc =>
            sc.setName('addword')
              .setDescription('Plan de volgende ronde (+1u na vorige) zonder direct te starten')
              .addStringOption(o =>
                  o.setName('woord')
                   .setDescription('Het woord voor de volgende ronde')
                   .setRequired(true)
              )
        )
        .addSubcommand(sc =>
            sc.setName('loadembed')
              .setDescription('Plaats de Check‑in embed met Insturen‑knop in dit kanaal')
                            .addChannelOption(o =>
                                    o.setName('kanaal')
                                     .setDescription('Optioneel: kanaal om de embed te plaatsen')
                                     .addChannelTypes(ChannelType.GuildText)
                            )
        )
                .addSubcommand(sc =>
                        sc.setName('checkuser')
                            .setDescription('Bekijk checkins van een gebruiker')
                            .addUserOption(o =>
                                    o.setName('gebruiker')
                                     .setDescription('De gebruiker om te controleren')
                                     .setRequired(true)
                            )
                )
                            .addSubcommand(sc =>
                                sc.setName('players')
                                    .setDescription('Bekijk spelersstatistieken voor een checkin sessie/ronde')
                                    .addIntegerOption(o =>
                                        o.setName('ronde')
                                         .setDescription('Optioneel: rondenummer om te analyseren')
                                         .setMinValue(1)
                                    )
                                        .addStringOption(o =>
                                        o.setName('sessie')
                                             .setDescription('Optioneel: sessienaam (standaard laatste sessie)')
                                    )
                            )
                                .addSubcommand(sc =>
                                    sc.setName('sessions')
                                        .setDescription('Bekijk alle checkin sessies met aantal rondes')
                                )
                .addSubcommand(sc =>
                        sc.setName('end')
                            .setDescription('Beëindig de sessie en toon de Top 15 ranking')
                )
                .addSubcommand(sc =>
                        sc.setName('changetime')
                            .setDescription('Pas de minuten van aankomende rondes aan voor deze sessie')
                            .addIntegerOption(o =>
                                    o.setName('minutes')
                                     .setDescription('Minuten (0–59) waarop rondes moeten starten')
                                     .setRequired(true)
                            )
                )
                .addSubcommand(sc =>
                        sc.setName('nextround')
                            .setDescription('Ga direct naar de volgende ronde en vervroeg alle volgende rondes met 1 uur')
                )
                .addSubcommand(sc =>
                        sc.setName('losers')
                            .setDescription('Bekijk alle afgevallen spelers')
                            .addStringOption(o =>
                                    o.setName('sessienaam')
                                     .setDescription('Naam van de sessie (optioneel, standaard laatste sessie)')
                            )
                )
                .addSubcommand(sc =>
                        sc.setName('leaderboard')
                            .setDescription('Bekijk het leaderboard van alle spelers')
                            .addStringOption(o =>
                                    o.setName('sessienaam')
                                     .setDescription('Naam van de sessie (optioneel, standaard laatste sessie)')
                            )
                )
                .addSubcommand(sc =>
                        sc.setName('schedule')
                            .setDescription('Bekijk alle rondes en woorden van de huidige sessie')
                )
                .addSubcommand(sc =>
                        sc.setName('changeword')
                            .setDescription('Pas het woord van een specifieke ronde aan')
                            .addIntegerOption(o =>
                                    o.setName('ronde')
                                     .setDescription('Het rondenummer')
                                     .setRequired(true)
                            )
                            .addStringOption(o =>
                                    o.setName('woord')
                                     .setDescription('Het nieuwe woord')
                                     .setRequired(true)
                            )
                ),

    async execute(interaction, pool) {
        // Check of checkin systeem is ingeschakeld
        if (!config.features.checkin) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Checkin uitgeschakeld')
                .setDescription('Het checkin systeem is momenteel uitgeschakeld.')
                .setColor(0xFF0000);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;
        const userId = interaction.user.id;

        // CREATE
        if (sub === 'create') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const active = await getActiveSession(pool, guildId);
            if (active) {
                return interaction.reply({ content: 'Er is al een actieve checkin‑sessie in deze server.', flags: 64 });
            }
            const [existingPending] = await pool.query(
                'SELECT id FROM checkin_session WHERE guild_id = ? AND active = 0 AND ended_at IS NULL LIMIT 1',
                [guildId]
            );
            if (existingPending.length) {
                return interaction.reply({ content: 'Er bestaat al een niet-gestarte sessie. Voeg woorden toe met /checkin addword of start met /checkin start.', flags: 64 });
            }
            const naam = (interaction.options.getString('naam') || '').trim();
            await ensureSessionNameSupport(pool);
            if (SESSION_NAME_COL && naam) {
                const sql = `INSERT INTO checkin_session (guild_id, channel_id, started_by, started_at, active_round, active, ${SESSION_NAME_COL}) VALUES (?, ?, ?, NOW(), 0, 0, ?)`;
                await pool.query(sql, [guildId, channelId, userId, naam]);
            } else {
                await pool.query(
                    'INSERT INTO checkin_session (guild_id, channel_id, started_by, started_at, active_round, active) VALUES (?, ?, ?, NOW(), 0, 0)',
                    [guildId, channelId, userId]
                );
            }
            const embed = new EmbedBuilder()
                .setTitle(`✅ Checkin‑sessie aangemaakt${naam ? ` — ${naam}` : ''}`)
                .setDescription(embedSections(
                    embedSection(
                        'Volgende stappen',
                        [
                            '/checkin addword <woord> (woorden inplannen)',
                            '/checkin start (sessie starten)',
                            '/checkin loadembed (insturen-knop plaatsen)',
                            '/checkin checkuser <gebruiker> (voortgang bekijken)',
                            '/checkin end (sessie beëindigen)'
                        ].join('\n')
                    )
                ))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // START
        if (sub === 'start') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const active = await getActiveSession(pool, guildId);
            if (active) {
                return interaction.reply({ content: 'Er is al een actieve checkin‑sessie in deze server.', flags: 64 });
            }
            const [rows] = await pool.query(
                'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 0 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
                [guildId]
            );
            const session = rows[0] || null;
            if (!session) {
                return interaction.reply({ content: 'Er is geen aangemaakte, niet-gestarte sessie. Gebruik /checkin create.', flags: 64 });
            }

            const [rounds] = await pool.query(
                'SELECT id, round_number FROM checkin_round WHERE session_id = ? ORDER BY round_number ASC',
                [session.id]
            );
            if (!rounds.length) {
                return interaction.reply({ content: 'Er zijn nog geen woorden ingepland. Voeg woorden toe met /checkin addword.', flags: 64 });
            }

            // Eerste ronde: huidig uur, tenzij minder dan 30 min tot het volgende uur.
            const now = new Date();
            const base = new Date(now);
            base.setMinutes(0, 0, 0);
            if (now.getMinutes() > 30) {
                base.setHours(base.getHours() + 1);
            }

            for (let i = 0; i < rounds.length; i++) {
                const r = rounds[i];
                const start = new Date(base.getTime() + i * 60 * 60 * 1000);
                await pool.query('UPDATE checkin_round SET start_time = ? WHERE id = ?', [start, r.id]);
            }

            const firstRoundNumber = rounds[0].round_number;
            await pool.query('UPDATE checkin_session SET active = 1, active_round = ? WHERE id = ?', [firstRoundNumber, session.id]);

            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);

            const embed = new EmbedBuilder()
                .setTitle(`🚀 Checkin‑sessie gestart${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(embedSections(
                    embedSection('Actieve ronde', String(firstRoundNumber))
                ))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // RESETROUND
        if (sub === 'resetround') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const rondeNummer = interaction.options.getInteger('ronde');
            const nieuwWoord = (interaction.options.getString('woord') || '').trim();

            const session = await getActiveSession(pool, guildId);
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve sessie.', flags: 64 });
            }

            const [[round]] = await pool.query(
                'SELECT * FROM checkin_round WHERE session_id = ? AND round_number = ? LIMIT 1',
                [session.id, rondeNummer]
            );

            if (!round) {
                return interaction.reply({ content: `Ronde ${rondeNummer} bestaat niet in deze sessie.`, flags: 64 });
            }

            // 1) Verlaag total_checkins voor alle gebruikers die in deze ronde een correcte invoer hebben gedaan.
            await pool.query(
                `
                UPDATE checkin_player p
                JOIN checkin_entry e ON e.session_id = p.session_id AND e.user_id = p.user_id
                SET p.total_checkins = GREATEST(p.total_checkins - 1, 0)
                WHERE e.round_id = ? AND e.is_correct = 1 AND p.session_id = ?
                `,
                [round.id, session.id]
            );

            // 2) Herstel spelers die geëlimineerd waren vanwege verkeerde inzendingen in deze ronde
            await pool.query(
                `
                UPDATE checkin_player p
                JOIN checkin_entry e ON e.session_id = p.session_id AND e.user_id = p.user_id
                SET p.eliminated = 0, p.eliminated_reason = NULL, p.eliminated_at = NULL
                WHERE e.round_id = ? AND e.is_correct = 0 AND p.session_id = ?
                `,
                [round.id, session.id]
            );

            // 3) Verwijder alle inzendingen voor deze ronde zodat iedereen opnieuw kan inzenden
            await pool.query('DELETE FROM checkin_entry WHERE round_id = ? AND session_id = ?', [round.id, session.id]);

            // 4) Update het ronde-woord indien opgegeven
            if (nieuwWoord) {
                await pool.query('UPDATE checkin_round SET word = ? WHERE id = ?', [nieuwWoord, round.id]);
            }

            // Als ronde 1 is gereset, mogen nieuwe spelers vanaf latere rondes alsnog instromen.
            if (rondeNummer === 1) {
                await pool.query(
                    'UPDATE checkin_session SET allow_late_join_after_round1_reset = 1 WHERE id = ?',
                    [session.id]
                );
            }

            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);

            const embed = new EmbedBuilder()
                .setTitle(`🔁 Ronde ${rondeNummer} gereset${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(embedSections(
                    embedSection('Wijzigingen', [
                        'Alle inzendingen voor deze ronde zijn verwijderd',
                        'Afgevallen spelers uit deze ronde mogen weer meedoen',
                        nieuwWoord ? `Woord aangepast naar: ${nieuwWoord}` : 'Woord is niet gewijzigd'
                    ].join('\n'))
                ))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // NEXTRound: beeldigt de huidige ronde en gaat naar de volgende en zorg ervoor dat de flow blijft kloppen
        if (sub === 'nextround') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const session = await getActiveSession(pool, guildId);
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve sessie.', flags: 64 });
            }

            const prevActive = await getActiveRound(pool, session.id);
            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);
            const [[nextRow]] = await pool.query(
                'SELECT * FROM checkin_round WHERE session_id = ? AND round_number > ? ORDER BY round_number ASC LIMIT 1',
                [session.id, session.active_round || 0]
            );
            if (!nextRow) {
                return interaction.reply({ content: 'Er is geen volgende ronde.', flags: 64 });
            }

            // Finalize previous round (eliminate misses) if there was one
            if (prevActive) {
                await finalizePreviousRoundAndEliminateMisses(pool, session.id, prevActive.id, interaction.guild, sessionName);
            }

            // Compute aligned start for the next round
            const minuteOffset = session.minute_offset ?? 0;
            const baseNow = nextAlignedMinute(minuteOffset);

            // Set the next round as active and set its start_time to aligned-now
            await pool.query('UPDATE checkin_round SET start_time = ? WHERE id = ?', [baseNow, nextRow.id]);
            await pool.query('UPDATE checkin_session SET active_round = ? WHERE id = ?', [nextRow.round_number, session.id]);

            // Shift all following rounds earlier by 1 hour to preserve hourly spacing
            await pool.query(
                'UPDATE checkin_round SET start_time = DATE_SUB(start_time, INTERVAL 1 HOUR) WHERE session_id = ? AND round_number > ?',
                [session.id, nextRow.round_number]
            );

            const embed = new EmbedBuilder()
                .setTitle(`⏭️ Overgegaan naar ronde ${nextRow.round_number}`)
                .setDescription(embedSections(`Alle volgende rondes zijn met 1 uur vervroegd.`))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        if (sub === 'checkuser') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const target = interaction.options.getUser('gebruiker');
            if (!target) {
                return interaction.reply({ content: 'Ongeldige gebruiker.', flags: 64 });
            }

            let session = await getActiveSession(pool, guildId);
            if (!session) {
                const [rows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 0 ORDER BY ended_at DESC LIMIT 1',
                    [guildId]
                );
                session = rows[0] || null;
            }

            if (!session) {
                return interaction.reply({ content: 'Er is nog geen sessie geweest in deze server.', flags: 64 });
            }

            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);

            const [[player]] = await pool.query(
                'SELECT total_checkins FROM checkin_player WHERE session_id = ? AND user_id = ? LIMIT 1',
                [session.id, target.id]
            );
            const achieved = player ? player.total_checkins : 0;
            const toAchieve = session.active_round || 0;

            const embed = new EmbedBuilder()
                .setTitle(`📋 Checkin voortgang${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(embedSections(
                    embedSection('Gebruiker', `<@${target.id}> (${target.id})`),
                    embedSection('Voortgang', `${achieved}/${toAchieve}`)
                ))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // PLAYERS
        if (sub === 'players') {
            if (!isModOrAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }

            const requestedRound = interaction.options.getInteger('ronde');
            const requestedSessionName = (interaction.options.getString('sessie') || '').trim();

            await ensureSessionNameSupport(pool);

            let session = null;
            if (requestedSessionName) {
                if (!SESSION_NAME_COL) {
                    return interaction.reply({
                        content: 'Sessienaam wordt niet ondersteund in deze database.',
                        flags: 64
                    });
                }

                const [rows] = await pool.query(
                    `SELECT * FROM checkin_session WHERE guild_id = ? AND ${SESSION_NAME_COL} = ? ORDER BY started_at DESC LIMIT 1`,
                    [guildId, requestedSessionName]
                );
                session = rows[0] || null;
                if (!session) {
                    return interaction.reply({
                        content: `Sessie met naam "${requestedSessionName}" is niet gevonden in deze server.`,
                        flags: 64
                    });
                }
            }

            if (!session) {
                session = await getActiveSession(pool, guildId);
            }
            if (!session) {
                session = await getLatestSession(pool, guildId);
            }

            if (!session) {
                return interaction.reply({ content: 'Er is nog geen checkin sessie in deze server.', flags: 64 });
            }

            const sessionName = getSessionDisplayName(session);

            const [[lastRoundRow]] = await pool.query(
                'SELECT MAX(round_number) AS max_round FROM checkin_round WHERE session_id = ?',
                [session.id]
            );
            const maxRound = Number(lastRoundRow?.max_round || 0);

            if (!maxRound) {
                return interaction.reply({ content: 'Deze sessie heeft nog geen rondes.', flags: 64 });
            }

            const currentActiveRound = session.active ? Number(session.active_round || 0) : 0;
            const defaultRound = session.active
                ? Math.max(Math.min(currentActiveRound, maxRound), 1)
                : Math.max(Math.min(maxRound, Number(session.active_round || maxRound)), 1);

            const targetRound = requestedRound || defaultRound;

            if (targetRound < 1 || targetRound > maxRound) {
                return interaction.reply({
                    content: `Ronde ${targetRound} bestaat niet in deze sessie. Beschikbare rondes: 1 t/m ${maxRound}.`,
                    flags: 64
                });
            }

            const [[totals]] = await pool.query(
                `SELECT
                    COUNT(*) AS total_players,
                    SUM(CASE WHEN total_checkins >= ? THEN 1 ELSE 0 END) AS reached_players,
                    SUM(CASE WHEN eliminated = 0 THEN 1 ELSE 0 END) AS active_players
                 FROM checkin_player
                 WHERE session_id = ?`,
                [targetRound, session.id]
            );

            const totalPlayers = Number(totals?.total_players || 0);
            const reachedPlayers = Number(totals?.reached_players || 0);
            const activePlayers = Number(totals?.active_players || 0);
            const reachedPercent = formatPercent(reachedPlayers, totalPlayers);

            let liveProgress = null;
            const isRequestedRoundCurrentlyActive = session.active && currentActiveRound === targetRound;

            if (isRequestedRoundCurrentlyActive) {
                const [[checkinRow]] = await pool.query(
                    `SELECT COUNT(DISTINCT e.user_id) AS already_checked
                     FROM checkin_entry e
                     JOIN checkin_player p
                       ON p.session_id = e.session_id
                      AND p.user_id = e.user_id
                     JOIN checkin_round r
                       ON r.id = e.round_id
                     WHERE e.session_id = ?
                       AND r.round_number = ?
                       AND e.is_correct = 1
                       AND p.eliminated = 0`,
                    [session.id, targetRound]
                );

                const alreadyChecked = Number(checkinRow?.already_checked || 0);
                liveProgress = `${alreadyChecked}/${activePlayers}`;
            }

            const lines = [
                embedSection('Gehaald', `${reachedPlayers}/${totalPlayers} spelers`),
                embedSection('Percentage', reachedPercent)
            ];

            if (liveProgress) {
                lines.push(embedSection(`Huidige ronde (${targetRound})`, `${liveProgress}`));
            } else if (!requestedRound && targetRound >= 1) {
                const [[lastRoundChecks]] = await pool.query(
                    `SELECT COUNT(DISTINCT e.user_id) AS checked_players
                     FROM checkin_entry e
                     JOIN checkin_round r ON r.id = e.round_id
                     WHERE e.session_id = ? AND r.round_number = ? AND e.is_correct = 1`,
                    [session.id, targetRound]
                );
                const checkedPlayers = Number(lastRoundChecks?.checked_players || 0);
                lines.push(embedSection(`Checkins ronde ${targetRound}`, `${checkedPlayers}/${totalPlayers}`));
            }

            const embed = new EmbedBuilder()
                .setTitle(`👥 Checkin spelers${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(lines.join('\n'))
                .setColor(EMBED_COLOR)
                .setFooter({ text: `Sessie ID: ${session.id} • Ronde: ${targetRound}` });

            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // SESSIONS
        if (sub === 'sessions') {
            if (!isModOrAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }

            await ensureSessionNameSupport(pool);

            const nameSelect = SESSION_NAME_COL ? `s.${SESSION_NAME_COL} AS session_name,` : `NULL AS session_name,`;
            const [sessions] = await pool.query(
                `SELECT
                    s.id,
                    ${nameSelect}
                    s.active,
                    s.started_at,
                    s.ended_at,
                    COALESCE(MAX(r.round_number), 0) AS rounds
                 FROM checkin_session s
                 LEFT JOIN checkin_round r ON r.session_id = s.id
                 WHERE s.guild_id = ?
                 GROUP BY s.id
                 ORDER BY s.started_at DESC`,
                [guildId]
            );

            if (!sessions.length) {
                const embed = new EmbedBuilder()
                    .setTitle('📚 Checkin sessies')
                    .setDescription('Er zijn nog geen sessies gevonden.')
                    .setColor(EMBED_COLOR);
                return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const lines = sessions.map(s => {
                const name = String(s.session_name || `Sessie ${s.id}`);
                const status = s.active ? 'Actief' : 'Beëindigd';
                return `• **${name}** — ${s.rounds} rondes (${status})`;
            });

            const chunks = [];
            let current = [];
            let currentLen = 0;
            for (const line of lines) {
                const nextLen = currentLen + line.length + 1;
                if (nextLen > 3500 && current.length) {
                    chunks.push(current.join('\n'));
                    current = [line];
                    currentLen = line.length + 1;
                } else {
                    current.push(line);
                    currentLen = nextLen;
                }
            }
            if (current.length) chunks.push(current.join('\n'));

            const firstEmbed = new EmbedBuilder()
                .setTitle('📚 Checkin sessies')
                .setDescription(chunks[0])
                .setColor(EMBED_COLOR)
                .setFooter({ text: `Totaal sessies: ${sessions.length} • Pagina 1/${chunks.length}` });

            await interaction.reply({ embeds: [firstEmbed], flags: 64 });

            for (let i = 1; i < chunks.length; i++) {
                const embed = new EmbedBuilder()
                    .setTitle('📚 Checkin sessies')
                    .setDescription(chunks[i])
                    .setColor(EMBED_COLOR)
                    .setFooter({ text: `Totaal sessies: ${sessions.length} • Pagina ${i + 1}/${chunks.length}` });
                await interaction.followUp({ embeds: [embed], flags: 64 });
            }
            return;
        }

        // ADDWORD
        if (sub === 'addword') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const woordRaw = interaction.options.getString('woord');
            const woord = woordRaw.trim();
            if (!woord) {
                return interaction.reply({ content: 'Ongeldig woord.', flags: 64 });
            }
            let session = await getActiveSession(pool, guildId);
            if (!session) {
                const [pendingRows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 0 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
                    [guildId]
                );
                session = pendingRows[0] || null;
            }
            if (!session) {
                return interaction.reply({ content: 'Er is geen sessie. Maak er één met /checkin create.', flags: 64 });
            }

            const lastRound = await getCurrentRound(pool, session.id);
            let nextStart;
            let nextRoundNumber = 1;
            if (lastRound) {
                nextStart = new Date(lastRound.start_time.getTime() + 60 * 60 * 1000);
                nextRoundNumber = lastRound.round_number + 1;
            } else {
                // Align first scheduled round to session.minute_offset (or next hour)
                const minuteOffset = session.minute_offset ?? 0;
                nextStart = nextAlignedMinute(minuteOffset);
            }

            await pool.query(
                'INSERT INTO checkin_round (session_id, round_number, word, start_time) VALUES (?, ?, ?, ?)',
                [session.id, nextRoundNumber, woord, nextStart]
            );

            const ts = Math.floor(nextStart.getTime() / 1000);
            const embed = new EmbedBuilder()
                .setTitle(`🗓️ Ronde ${nextRoundNumber} ingepland`)
                .setDescription(embedSections(
                    embedSection('Starttijd', session.active ? `<t:${ts}:F> (wordt automatisch gestart)` : 'Wordt gestart zodra de sessie start')
                ))
                .setFooter({ text: `Woord (debug): ${woord}` })
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // LOADEMBED
        if (sub === 'loadembed') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const targetChannel = interaction.options.getChannel('kanaal') || interaction.channel;
            const embed = new EmbedBuilder()
                .setTitle('📥 Check‑in')
                .setDescription(embedSections(
                    embedSection('Stap 1', 'Klik op de knop Insturen'),
                    embedSection('Stap 2', 'Vul het woord in het formulier in en verzend')
                ))
                .setColor(EMBED_COLOR);

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('checkin_submit_button')
                    .setLabel('Insturen')
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({ content: 'Embed geplaatst.', flags: 64 });
            await targetChannel.send({ embeds: [embed], components: [buttonRow] });
            return;
        }

        // END
        if (sub === 'end') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const session = await getActiveSession(pool, guildId);
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve sessie om te beëindigen.', flags: 64 });
            }

            const currentRound = await getActiveRound(pool, session.id);
            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);
            if (currentRound) {
                await finalizePreviousRoundAndEliminateMisses(pool, session.id, currentRound.id, interaction.guild, sessionName);
            }

            await pool.query('UPDATE checkin_session SET active = 0, ended_at = NOW() WHERE id = ?', [session.id]);

            const totalRounds = session.active_round || 0;

            const [players] = await pool.query(
                `SELECT user_id, total_checkins, eliminated
                 FROM checkin_player
                 WHERE session_id = ?
                 ORDER BY total_checkins DESC, user_id ASC`,
                [session.id]
            );

            if (players.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(`🏁 Checkin‑sessie beëindigd${sessionName ? ` — ${sessionName}` : ''}`)
                    .setDescription('Geen deelnemers in deze sessie.')
                    .setColor(EMBED_COLOR)
                    .setTimestamp(new Date());
                return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const perPage = 10;
            const totalPages = Math.ceil(players.length / perPage);
            const page = 0;

            const embed = buildLeaderboardEmbed(players, page, perPage, totalPages, totalRounds, sessionName, true);
            const row = buildPaginationRow('checkin_leaderboard', session.id, page, totalPages);

            return interaction.reply({ embeds: [embed], components: totalPages > 1 ? [row] : [], flags: 64 });
        }

        // CHANGETIME
        if (sub === 'changetime') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const minutes = interaction.options.getInteger('minutes');
            if (minutes == null || minutes < 0 || minutes > 59) {
                return interaction.reply({ content: 'Geef een geldig aantal minuten (0–59).', flags: 64 });
            }

            const session = await getActiveSession(pool, guildId);
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve sessie om de tijden aan te passen.', flags: 64 });
            }

            const currentRound = await getActiveRound(pool, session.id);
            if (!currentRound) {
                return interaction.reply({ content: 'Er is momenteel geen actieve ronde om vanaf te wijzigen.', flags: 64 });
            }

            // Update session minute offset
            await pool.query('UPDATE checkin_session SET minute_offset = ? WHERE id = ?', [minutes, session.id]);

            // Compute new base aligned time
            const base = nextAlignedMinute(minutes);

            const [rows] = await pool.query(
                'SELECT id, round_number FROM checkin_round WHERE session_id = ? AND round_number >= ? ORDER BY round_number ASC',
                [session.id, currentRound.round_number]
            );

            for (const r of rows) {
                const offsetHours = r.round_number - currentRound.round_number;
                const start = new Date(base.getTime() + offsetHours * 60 * 60 * 1000);
                await pool.query('UPDATE checkin_round SET start_time = ? WHERE id = ?', [start, r.id]);
            }

            const embed = new EmbedBuilder()
                .setTitle('⏱️ Ronde tijden aangepast')
                .setDescription(embedSections(
                    embedSection('Vanaf ronde', String(currentRound.round_number)),
                    embedSection('Nieuwe minuten', String(minutes)),
                    embedSection('Aangepaste rondes', String(rows.length))
                ))
                .setColor(EMBED_COLOR);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // LOSERS
        if (sub === 'losers') {
            if (!isModOrAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }
            const sessienaam = (interaction.options.getString('sessienaam') || '').trim();
            await ensureSessionNameSupport(pool);

            let session;
            if (sessienaam && SESSION_NAME_COL) {
                const [rows] = await pool.query(
                    `SELECT * FROM checkin_session WHERE guild_id = ? AND ${SESSION_NAME_COL} = ? ORDER BY started_at DESC LIMIT 1`,
                    [guildId, sessienaam]
                );
                session = rows[0] || null;
            }
            if (!session) {
                const [rows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1',
                    [guildId]
                );
                session = rows[0] || null;
            }
            if (!session) {
                return interaction.reply({ content: 'Er is geen sessie gevonden.', flags: 64 });
            }

            const sessionName = getSessionDisplayName(session);
            const totalRounds = session.active_round || 0;

            const [losers] = await pool.query(
                `SELECT user_id, total_checkins, eliminated_reason, eliminated_at
                 FROM checkin_player
                 WHERE session_id = ? AND eliminated = 1
                 ORDER BY total_checkins DESC, eliminated_at ASC`,
                [session.id]
            );

            if (losers.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(`💀 Afgevallen spelers${sessionName ? ` — ${sessionName}` : ''}`)
                    .setDescription('Er zijn geen afgevallen spelers.')
                    .setColor(EMBED_COLOR);
                return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const perPage = 10;
            const totalPages = Math.ceil(losers.length / perPage);
            const page = 0;

            const embed = buildLosersEmbed(losers, page, perPage, totalPages, totalRounds, sessionName);
            const row = buildPaginationRow('checkin_losers', session.id, page, totalPages);

            return interaction.reply({ embeds: [embed], components: totalPages > 1 ? [row] : [], flags: 64 });
        }

        // LEADERBOARD
        if (sub === 'leaderboard') {
            const sessienaam = (interaction.options.getString('sessienaam') || '').trim();
            await ensureSessionNameSupport(pool);

            let session;
            if (sessienaam && SESSION_NAME_COL) {
                const [rows] = await pool.query(
                    `SELECT * FROM checkin_session WHERE guild_id = ? AND ${SESSION_NAME_COL} = ? ORDER BY started_at DESC LIMIT 1`,
                    [guildId, sessienaam]
                );
                session = rows[0] || null;
            }
            if (!session) {
                const [rows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1',
                    [guildId]
                );
                session = rows[0] || null;
            }
            if (!session) {
                return interaction.reply({ content: 'Er is geen sessie gevonden.', flags: 64 });
            }

            const sessionName = getSessionDisplayName(session);
            const totalRounds = session.active_round || 0;

            const [players] = await pool.query(
                `SELECT user_id, total_checkins, eliminated
                 FROM checkin_player
                 WHERE session_id = ?
                 ORDER BY total_checkins DESC, user_id ASC`,
                [session.id]
            );

            if (players.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(`🏆 Leaderboard${sessionName ? ` — ${sessionName}` : ''}`)
                    .setDescription('Er zijn geen spelers.')
                    .setColor(EMBED_COLOR);
                return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const perPage = 10;
            const totalPages = Math.ceil(players.length / perPage);
            const page = 0;

            const embed = buildLeaderboardEmbed(players, page, perPage, totalPages, totalRounds, sessionName);
            const row = buildPaginationRow('checkin_leaderboard', session.id, page, totalPages);

            return interaction.reply({ embeds: [embed], components: totalPages > 1 ? [row] : [], flags: 64 });
        }

        // SCHEDULE
        if (sub === 'schedule') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }

            let session = await getActiveSession(pool, guildId);
            if (!session) {
                const [pendingRows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 0 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
                    [guildId]
                );
                session = pendingRows[0] || null;
            }
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve of aangemaakte sessie.', flags: 64 });
            }

            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);

            const [rounds] = await pool.query(
                'SELECT round_number, word, start_time FROM checkin_round WHERE session_id = ? ORDER BY round_number ASC',
                [session.id]
            );

            if (rounds.length === 0) {
                const embed = new EmbedBuilder()
                    .setTitle(`📋 Schema${sessionName ? ` — ${sessionName}` : ''}`)
                    .setDescription('Er zijn nog geen rondes ingepland.')
                    .setColor(EMBED_COLOR);
                return interaction.reply({ embeds: [embed], flags: 64 });
            }

            const now = new Date();
            const activeRound = session.active_round || 0;

            const lines = rounds.map(r => {
                const ts = Math.floor(new Date(r.start_time).getTime() / 1000);
                let status;
                if (r.round_number < activeRound) {
                    status = '✅'; // Beëindigd
                } else if (r.round_number === activeRound) {
                    status = '🔴'; // Huidige/actief
                } else {
                    status = '⏳'; // Nog te starten
                }
                return `${status} **Ronde ${r.round_number}** — \`${r.word}\` — <t:${ts}:t> (<t:${ts}:R>)`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`📋 Schema${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(lines.join('\n'))
                .setColor(EMBED_COLOR)
                .setFooter({ text: `✅ Beëindigd • 🔴 Actief • ⏳ Gepland | ${rounds.length} rondes` });

            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        // CHANGEWORD
        if (sub === 'changeword') {
            if (!isAdmin(interaction.member)) {
                return interaction.reply({ content: 'Je hebt geen toestemming voor dit commando.', flags: 64 });
            }

            const rondeNummer = interaction.options.getInteger('ronde');
            const nieuwWoord = (interaction.options.getString('woord') || '').trim();

            if (!nieuwWoord) {
                return interaction.reply({ content: 'Geef een geldig woord op.', flags: 64 });
            }

            let session = await getActiveSession(pool, guildId);
            if (!session) {
                const [pendingRows] = await pool.query(
                    'SELECT * FROM checkin_session WHERE guild_id = ? AND active = 0 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
                    [guildId]
                );
                session = pendingRows[0] || null;
            }
            if (!session) {
                return interaction.reply({ content: 'Er is geen actieve of aangemaakte sessie.', flags: 64 });
            }

            const [[round]] = await pool.query(
                'SELECT * FROM checkin_round WHERE session_id = ? AND round_number = ? LIMIT 1',
                [session.id, rondeNummer]
            );

            if (!round) {
                return interaction.reply({ content: `Ronde ${rondeNummer} bestaat niet in deze sessie.`, flags: 64 });
            }

            const oudWoord = round.word;
            await pool.query(
                'UPDATE checkin_round SET word = ? WHERE id = ?',
                [nieuwWoord, round.id]
            );

            await ensureSessionNameSupport(pool);
            const sessionName = getSessionDisplayName(session);

            const embed = new EmbedBuilder()
                .setTitle(`✏️ Woord aangepast${sessionName ? ` — ${sessionName}` : ''}`)
                .setDescription(embedSections(
                    embedSection('Ronde', String(rondeNummer)),
                    embedSection('Oud woord', oudWoord),
                    embedSection('Nieuw woord', nieuwWoord)
                ))
                .setColor(EMBED_COLOR);

            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        return interaction.reply({ content: 'Ongeldige subcommand.', flags: 64 });
    },

    // UI handlers
    async handleButton(interaction, pool) {
        // Handle pagination buttons for losers/leaderboard
        if (interaction.customId.startsWith('checkin_losers_') || interaction.customId.startsWith('checkin_leaderboard_')) {
            const parts = interaction.customId.split('_');
            const type = parts[1]; // 'losers' or 'leaderboard'
            const direction = parts[2]; // 'prev' or 'next'
            const sessionId = parseInt(parts[3], 10);
            const currentPage = parseInt(parts[4], 10);

            const newPage = direction === 'prev' ? currentPage - 1 : currentPage + 1;

            await ensureSessionNameSupport(pool);
            const [[session]] = await pool.query('SELECT * FROM checkin_session WHERE id = ?', [sessionId]);
            if (!session) {
                await interaction.reply({ content: 'Sessie niet gevonden.', flags: 64 });
                return true;
            }

            const sessionName = getSessionDisplayName(session);
            const totalRounds = session.active_round || 0;
            const perPage = 10;

            if (type === 'losers') {
                const [losers] = await pool.query(
                    `SELECT user_id, total_checkins, eliminated_reason, eliminated_at
                     FROM checkin_player
                     WHERE session_id = ? AND eliminated = 1
                     ORDER BY total_checkins DESC, eliminated_at ASC`,
                    [sessionId]
                );
                const totalPages = Math.ceil(losers.length / perPage);
                const embed = buildLosersEmbed(losers, newPage, perPage, totalPages, totalRounds, sessionName);
                const row = buildPaginationRow('checkin_losers', sessionId, newPage, totalPages);
                await interaction.update({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
            } else {
                const [players] = await pool.query(
                    `SELECT user_id, total_checkins, eliminated
                     FROM checkin_player
                     WHERE session_id = ?
                     ORDER BY total_checkins DESC, user_id ASC`,
                    [sessionId]
                );
                const totalPages = Math.ceil(players.length / perPage);
                const embed = buildLeaderboardEmbed(players, newPage, perPage, totalPages, totalRounds, sessionName);
                const row = buildPaginationRow('checkin_leaderboard', sessionId, newPage, totalPages);
                await interaction.update({ embeds: [embed], components: totalPages > 1 ? [row] : [] });
            }
            return true;
        }

        if (interaction.customId !== 'checkin_submit_button') return false;

        if (!config.features.checkin) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Checkin uitgeschakeld')
                .setDescription('Het checkin systeem is momenteel uitgeschakeld.')
                .setColor(0xFF0000);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const guildId = interaction.guild?.id;
        if (!guildId) {
            await interaction.reply({ content: 'Deze actie kan alleen in een server.', flags: 64 });
            return true;
        }

        const userId = interaction.user.id;

        // Check active session and round before showing modal
        const session = await getActiveSession(pool, guildId);
        if (!session) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Geen actieve sessie')
                .setDescription('Er is momenteel geen actieve checkin‑sessie.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const round = await getActiveRound(pool, session.id);
        if (!round) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Geen actieve ronde')
                .setDescription('Er is nog geen ronde actief. Wacht tot de ronde start.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const [playerRows] = await pool.query(
            'SELECT * FROM checkin_player WHERE session_id = ? AND user_id = ? LIMIT 1',
            [session.id, userId]
        );
        const player = playerRows[0] || null;
        await ensureSessionNameSupport(pool);
        const sessionName = getSessionDisplayName(session);
        if (player?.eliminated) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Uitgeschakeld')
                .setDescription('Je bent uit het spel en kunt tijdens deze stream niet meer inchecken.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const lateJoinBlockReason = getLateJoinBlockReason(player, session, round);
        if (lateJoinBlockReason) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Te laat om te starten')
                .setDescription(
                    lateJoinBlockReason === 'round_two_closed'
                        ? 'Ronde 2 is al afgelopen. Nieuwe spelers kunnen niet meer instromen.'
                        : 'Ronde 1 gemist. Instromen kan pas weer na reset van ronde 1.'
                )
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const [entryRows] = await pool.query(
            'SELECT id, is_correct FROM checkin_entry WHERE session_id = ? AND round_id = ? AND user_id = ? LIMIT 1',
            [session.id, round.id, userId]
        );
        if (entryRows.length > 0) {
            const already = entryRows[0];
            if (already.is_correct) {
                const embed = new EmbedBuilder()
                    .setTitle('✅ Al ingecheckt')
                    .setDescription('Je hebt al succesvol ingecheckt voor deze ronde.')
                    .setColor(0x43b581);
                await interaction.reply({ embeds: [embed], flags: 64 });
                return true;
            } else {
                const embed = new EmbedBuilder()
                    .setTitle('⏳ Poging al gedaan')
                    .setDescription('Je hebt al een poging gedaan voor deze ronde.')
                    .setColor(0xFAA61A);
                await interaction.reply({ embeds: [embed], flags: 64 });
                return true;
            }
        }

        // All checks passed: show modal
        const modal = new ModalBuilder()
            .setCustomId('checkin_submit_modal')
            .setTitle('Check‑in Insturen');
        const input = new TextInputBuilder()
            .setCustomId('checkin_word')
            .setLabel('Woord op stream')
            .setPlaceholder('Typ het woord...')
            .setRequired(true)
            .setStyle(TextInputStyle.Short);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return true;
    },

    async handleModal(interaction, pool) {
        if (interaction.customId !== 'checkin_submit_modal') return false;

        if (!config.features.checkin) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Checkin uitgeschakeld')
                .setDescription('Het checkin systeem is momenteel uitgeschakeld.')
                .setColor(0xFF0000);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const guildId = interaction.guild?.id;
        if (!guildId) {
            await interaction.reply({ content: 'Deze actie kan alleen in een server.', flags: 64 });
            return true;
        }
        const userId = interaction.user.id;
        const woord = (interaction.fields.getTextInputValue('checkin_word') || '').trim();

        const session = await getActiveSession(pool, guildId);
        if (!session) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Geen actieve sessie')
                .setDescription('Er is momenteel geen actieve checkin‑sessie.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }
        const round = await getActiveRound(pool, session.id);
        if (!round) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Geen actieve ronde')
                .setDescription('Er is nog geen ronde actief. Wacht tot de ronde start.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const [playerRows] = await pool.query(
            'SELECT * FROM checkin_player WHERE session_id = ? AND user_id = ? LIMIT 1',
            [session.id, userId]
        );
        const player = playerRows[0] || null;
        await ensureSessionNameSupport(pool);
        const sessionName = getSessionDisplayName(session);
        if (player?.eliminated) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Uitgeschakeld')
                .setDescription('Je bent uit het spel en kunt tijdens deze stream niet meer inchecken.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const lateJoinBlockReason = getLateJoinBlockReason(player, session, round);
        if (lateJoinBlockReason) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Te laat om te starten')
                .setDescription(
                    lateJoinBlockReason === 'round_two_closed'
                        ? 'Ronde 2 is al afgelopen. Nieuwe spelers kunnen niet meer instromen.'
                        : 'Ronde 1 gemist. Instromen kan pas weer na reset van ronde 1.'
                )
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });
            return true;
        }

        const [entryRows] = await pool.query(
            'SELECT id, is_correct FROM checkin_entry WHERE session_id = ? AND round_id = ? AND user_id = ? LIMIT 1',
            [session.id, round.id, userId]
        );
        if (entryRows.length > 0) {
            const already = entryRows[0];
            if (already.is_correct) {
                const embed = new EmbedBuilder()
                    .setTitle('✅ Al ingecheckt')
                    .setDescription('Je hebt al succesvol ingecheckt voor deze ronde.')
                    .setColor(0x43b581);
                await interaction.reply({ embeds: [embed], flags: 64 });
                return true;
            } else {
                const embed = new EmbedBuilder()
                    .setTitle('⏳ Poging al gedaan')
                    .setDescription('Je hebt al een poging gedaan voor deze ronde.')
                    .setColor(0xFAA61A);
                await interaction.reply({ embeds: [embed], flags: 64 });
                return true;
            }
        }

        if (!woord) {
            await pool.query(
                'INSERT INTO checkin_entry (session_id, round_id, user_id, word_submitted, is_correct, submitted_at) VALUES (?, ?, ?, ?, 0, NOW())',
                [session.id, round.id, userId, '']
            );
            await pool.query(
                `
                INSERT INTO checkin_player (session_id, user_id, eliminated, eliminated_reason, eliminated_at, joined_at, total_checkins)
                VALUES (?, ?, 1, 'missed', NOW(), NOW(), 0)
                ON DUPLICATE KEY UPDATE
                    eliminated = 1,
                    eliminated_reason = 'missed',
                    eliminated_at = NOW()
                `,
                [session.id, userId]
            );

            const embed = new EmbedBuilder()
                .setTitle('❌ Check-in gemist')
                .setDescription('Geen woord ingevuld, je bent uit het spel en kunt tijdens deze stream niet meer inchecken.')
                .setColor(0xED4245);
            await interaction.reply({ embeds: [embed], flags: 64 });

            logCheckinMissed({
                guild: interaction.guild,
                userId,
                roundNumber: round.round_number,
                word: round.word,
                sessionName
            }).catch((err) => {
                console.error('[Checkin] logCheckinMissed failed:', err);
            });
            return true;
        }

        console.log('[Checkin] Submitted word:', woord, 'Stored round.word:', String(round.word || ''));
        const correct = woord === String(round.word || '');

        if (correct) {
            await pool.query(
                'INSERT INTO checkin_entry (session_id, round_id, user_id, word_submitted, is_correct, submitted_at) VALUES (?, ?, ?, ?, 1, NOW())',
                [session.id, round.id, userId, woord]
            );
            await pool.query(
                `
                INSERT INTO checkin_player (session_id, user_id, eliminated, total_checkins, joined_at)
                VALUES (?, ?, 0, 1, NOW())
                ON DUPLICATE KEY UPDATE 
                    total_checkins = total_checkins + 1
                `,
                [session.id, userId]
            );

            const [[me]] = await pool.query(
                'SELECT total_checkins FROM checkin_player WHERE session_id = ? AND user_id = ?',
                [session.id, userId]
            );

            const [[sessionRounds]] = await pool.query(
                'SELECT COUNT(*) AS total_rounds FROM checkin_round WHERE session_id = ?',
                [session.id]
            );
            const totalRounds = Number(sessionRounds?.total_rounds || 0);

            const embed = new EmbedBuilder()
                .setTitle('✅ Incheck gelukt')
                .setDescription(`Totaal aantal correcte checkins: **${me.total_checkins}/${totalRounds}**`)
                .setColor(0x43b581);

            await interaction.reply({ embeds: [embed], flags: 64 });

            logCheckinSuccess({
                guild: interaction.guild,
                userId,
                roundNumber: round.round_number,
                word: woord,
                sessionName
            }).catch((err) => {
                console.error('[Checkin] logCheckinSuccess failed:', err);
            });
            return true;
        } else {
            await pool.query(
                'INSERT INTO checkin_entry (session_id, round_id, user_id, word_submitted, is_correct, submitted_at) VALUES (?, ?, ?, ?, 0, NOW())',
                [session.id, round.id, userId, woord]
            );
            await pool.query(
                `
                INSERT INTO checkin_player (session_id, user_id, eliminated, eliminated_reason, eliminated_at, joined_at, total_checkins)
                VALUES (?, ?, 1, 'wrong', NOW(), NOW(), 0)
                ON DUPLICATE KEY UPDATE 
                    eliminated = 1,
                    eliminated_reason = 'wrong',
                    eliminated_at = NOW()
                `,
                [session.id, userId]
            );

            const embed = new EmbedBuilder()
                .setTitle('❌ Verkeerd woord')
                .setDescription('Verkeerd woord ingestuurd, je bent uit het spel en kunt tijdens deze stream dus niet meer inchecken.')
                .setColor(0xED4245);

            await interaction.reply({ embeds: [embed], flags: 64 });

            logCheckinWrongWord({
                guild: interaction.guild,
                userId,
                roundNumber: round.round_number,
                expectedWord: round.word,
                submittedWord: woord,
                sessionName
            }).catch((err) => {
                console.error('[Checkin] logCheckinWrongWord failed:', err);
            });
            return true;
        }
    }
};