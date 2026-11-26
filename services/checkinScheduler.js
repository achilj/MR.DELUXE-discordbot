const { logCheckinMissed } = require('./checkinLogs');

module.exports = function startCheckinScheduler(client, pool) {
    const POLL_MS = 30 * 1000;
    let preciseTimer = null;
    let tickInProgress = false;
    let tickQueued = false;

    async function eliminateForRound(sessionId, roundId) {
        const [[round]] = await pool.query(
            'SELECT round_number, word FROM checkin_round WHERE id = ? LIMIT 1',
            [roundId]
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
            [roundId, sessionId]
        );

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
            [roundId, sessionId]
        );

        return {
            round,
            missedRows
        };
    }

    async function tick() {
        const [sessions] = await pool.query('SELECT id, guild_id, active_round FROM checkin_session WHERE active = 1');

        for (const s of sessions) {
            const guild = client.guilds.cache.get(s.guild_id) || await client.guilds.fetch(s.guild_id).catch(() => null);

            // Start achterstallige rondes sequentieel tot er geen meer zijn
            /* eslint-disable no-await-in-loop */
            while (true) {
                const [rows] = await pool.query(
                    `
                    SELECT * FROM checkin_round
                    WHERE session_id = ?
                      AND round_number > COALESCE(?, 0)
                      AND start_time <= NOW()
                    ORDER BY round_number ASC
                    LIMIT 1
                    `,
                    [s.id, s.active_round || 0]
                );
                if (!rows.length) break;

                const next = rows[0];

                // Elimineer missers vorige ronde
                if (s.active_round && s.active_round > 0) {
                    const [prevRows] = await pool.query(
                        'SELECT id FROM checkin_round WHERE session_id = ? AND round_number = ? LIMIT 1',
                        [s.id, s.active_round]
                    );
                    if (prevRows.length) {
                        const result = await eliminateForRound(s.id, prevRows[0].id);
                        if (guild && result.round && result.missedRows.length) {
                            for (const row of result.missedRows) {
                                await logCheckinMissed({
                                    guild,
                                    userId: row.user_id,
                                    roundNumber: result.round.round_number,
                                    word: result.round.word
                                });
                            }
                        }
                    }
                }

                await pool.query('UPDATE checkin_session SET active_round = ? WHERE id = ?', [next.round_number, s.id]);

                s.active_round = next.round_number;
            }
            /* eslint-enable no-await-in-loop */
        }
    }

    async function schedulePreciseTimer() {
        if (preciseTimer) {
            clearTimeout(preciseTimer);
            preciseTimer = null;
        }

        const [[nextRow]] = await pool.query(
            `
            SELECT UNIX_TIMESTAMP(MIN(r.start_time)) AS next_start_unix
            FROM checkin_session s
            JOIN checkin_round r ON r.session_id = s.id
            WHERE s.active = 1
              AND r.round_number > COALESCE(s.active_round, 0)
            `
        );

        const nextStartUnix = Number(nextRow?.next_start_unix || 0);
        if (!nextStartUnix) return;

        const delayMs = Math.max(nextStartUnix * 1000 - Date.now(), 0);
        preciseTimer = setTimeout(() => {
            runSchedulerCycle('precise').catch(err => {
                console.error('[CheckinScheduler] Precise timer fout:', err);
            });
        }, Math.max(delayMs, 25));
    }

    async function runSchedulerCycle(source) {
        if (tickInProgress) {
            tickQueued = true;
            return;
        }

        tickInProgress = true;
        try {
            await tick();
            await schedulePreciseTimer();
        } catch (err) {
            console.error(`[CheckinScheduler] Cycle fout (${source}):`, err);
        } finally {
            tickInProgress = false;
            if (tickQueued) {
                tickQueued = false;
                setTimeout(() => {
                    runSchedulerCycle('queued').catch(err => {
                        console.error('[CheckinScheduler] Queued cycle fout:', err);
                    });
                }, 0);
            }
        }
    }

    // Start met een korte delay, daarna fallback checks elke 30 seconden.
    setTimeout(() => {
        runSchedulerCycle('startup').catch(err => {
            console.error('[CheckinScheduler] Startup fout:', err);
        });
    }, 5_000);

    setInterval(() => {
        runSchedulerCycle('poll').catch(err => {
            console.error('[CheckinScheduler] Poll fout:', err);
        });
    }, POLL_MS);
};