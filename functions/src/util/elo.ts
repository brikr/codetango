import {firestore} from 'firebase-admin';
import {toPairs} from 'lodash';

import {Game, GameStatus, Stats, Team} from '../../../types';

import {BigBatch} from './big-batch';
import {getChange} from './elo-math';

// elo variables
const BASE_ELO = 1200;
// removed this for now (set to 0), not sure I like the results - MT
const PROVISIONAL_GAMES = 0;

interface UserMap {
  [field: string]: Stats;
}

export async function recalcElo(
    db: any,  // RIP, tried to import firestore.Firestore
    timestamp: number,
    deletedGame?: Game,
) {
  // Update:
  //      eloHistory collection
  //          -> set one record per user so we can query them later for charts
  //      users collection with all affected users
  //          -> update the relevant stats for each user affected

  const userMap: UserMap = {};

  const games =
      await db.collection('games')
          .where('completedAt', '>=', timestamp)
          .orderBy('completedAt', 'asc')
          .limit(500)  // only do 500 games at a time so we don't timeout
          .get();

  console.log(`${games.size} games got got. starting calc`);

  const batch = new BigBatch(db);
  let lastTimestamp = 0;

  // if the game was deleted, we need to make sure the users in that
  // deleted game get added to the user map so their records get updated
  if (deletedGame) {
    console.log('adding users from deleted game', deletedGame);
    await populateUserMap(db, userMap, deletedGame);
  }

  for (let i = 0; i < games.size; i++) {
    const game = games.docs[i].data() as Game;
    game.id = games.docs[i].id;

    // set the userIds for the completed game
    const userIds = game.blueTeam.userIds.concat(game.redTeam.userIds);
    batch.update(games.docs[i].ref, {userIds});

    // ensure all of the users are in the userMap before passing that off to
    // the elo function
    await populateUserMap(db, userMap, game);

    // the setStats method will update several stats in the user map for each
    // user that played in the game
    setStats(game, userMap);

    // update elo history for all users involved
    for (const userId of game.blueTeam.userIds.concat(game.redTeam.userIds)) {
      batch.set(
          db.collection('eloHistory').doc(`${userId}_${game.id}`),
          {
            // clone the object and set gameId and timestamp
            ...userMap[userId],
            gameId: game.id,
            timestamp: game.completedAt,
          },
      );
    }

    lastTimestamp = game.completedAt!;
  }

  console.log('done with games, iterating through users');

  const userMapPairs = toPairs(userMap);
  for (const pair of userMapPairs) {
    const userId: string = pair[0];
    const data = pair[1];

    batch.update(db.collection('users').doc(userId), {
      'stats.elo': data.elo,
      'stats.gamesPlayed': data.gamesPlayed,
      'stats.gamesWon': data.gamesWon,
      'stats.spymasterGames': data.spymasterGames,
      'stats.spymasterWins': data.spymasterWins,
      'stats.spymasterStreak': data.spymasterStreak,
      'stats.spymasterBestStreak': data.spymasterBestStreak,
      'stats.assassinsAsSpymaster': data.assassinsAsSpymaster,
      'stats.currentStreak': data.currentStreak,
      'stats.bestStreak': data.bestStreak,
      'stats.provisional': data.provisional,
      'stats.lastPlayed': data.timestamp
    });
  }

  // wait for the batches to commit in order
  console.log('committing batches');
  await batch.commit();

  // "queue up" a new recalc starting where we left off
  console.log(`schedule? (${lastTimestamp} > ${timestamp})`);
  if (lastTimestamp > timestamp) {
    await db.collection('admin').doc('recalc').delete();
    await db.collection('admin').doc('recalc').set({timestamp: lastTimestamp});
    console.log('scheduling a new recalc starting from ' + lastTimestamp);
  }

  return 'ja!';
}

export async function getHighestElo(db: any, userId: string) {
  const snapshot = await db.collection('eloHistory')
                       .where('id', '==', userId)
                       .where('provisional', '==', false)
                       .orderBy('elo', 'desc')
                       .limit(1)
                       .get();

  return snapshot.size === 1 ? snapshot.docs[0].data().elo : undefined;
}

async function populateUserMap(db: any, userMap: UserMap, game: Game) {
  for (const userId of game.blueTeam.userIds.concat(game.redTeam.userIds)) {
    if (userMap[userId] === undefined) {
      userMap[userId] =
          await getEloHistoryForUser(db, userId, game.id!, game.completedAt!);
    }
  }
}

/**
 * Get the last known elo before the given timestamp
 * Doing it this way ensure we don't need to nuke the elo history
 */
export async function getEloHistoryForUser(
    db: any,
    userId: string,
    gameId: string,
    timestamp: number,
    ): Promise<Stats> {
  const snapshot = await db.collection('eloHistory')
                       .orderBy('timestamp', 'desc')  // desc is most recent
                       .where('userId', '==', userId)
                       .where('timestamp', '<', timestamp)
                       .limit(1)
                       .get();

  // there should only be 1 document per user
  // if there are none, then set up a base Stats object
  return snapshot.size === 1 ? snapshot.docs[0].data() as Stats : {
    userId,
    gameId,
    elo: BASE_ELO,
    gamesPlayed: 0,
    gamesWon: 0,
    spymasterGames: 0,
    spymasterWins: 0,
    spymasterStreak: 0,
    spymasterBestStreak: 0,
    assassinsAsSpymaster: 0,
    currentStreak: 0,
    bestStreak: 0,
    provisional: true,
    timestamp: timestamp,
  };
}

function setStats(game: Game, userMap: UserMap) {
  // update the stats for each user in the userMap
  const blueWon = game.status === GameStatus.BLUE_WON;
  const winningTeam = blueWon ? game.blueTeam : game.redTeam;
  const losingTeam = blueWon ? game.redTeam : game.blueTeam;

  const winnersRating = getTeamElo(winningTeam, userMap);
  const losersRating = getTeamElo(losingTeam, userMap);
  const delta = getChange(winnersRating, losersRating);

  // set stats for users on the winning team
  for (const winner of winningTeam.userIds) {
    const user = userMap[winner];
    user.elo += deltaWithProvisional(user.gamesPlayed, delta);
    user.gamesPlayed++;
    user.gamesWon++;
    user.currentStreak++;
    user.bestStreak = Math.max(user.bestStreak, user.currentStreak);

    // last played and provisional status
    user.timestamp = game.completedAt!;
    user.provisional = user.gamesPlayed < PROVISIONAL_GAMES;

    // this user was spymaster
    if (winningTeam.spymaster === winner) {
      user.spymasterGames++;
      user.spymasterWins++;
      user.spymasterStreak++;
      user.spymasterBestStreak =
          Math.max(user.spymasterBestStreak, user.spymasterStreak);
    }
  }

  // set stats for users on the losing team
  for (const loser of losingTeam.userIds) {
    const user = userMap[loser];
    user.elo += -deltaWithProvisional(user.gamesPlayed, delta);
    user.gamesPlayed++;
    user.currentStreak = 0;

    // last played and provisional status
    user.timestamp = game.completedAt!;
    user.provisional = user.gamesPlayed < PROVISIONAL_GAMES;

    // this user was spymaster
    if (losingTeam.spymaster === loser) {
      user.spymasterGames++;
      user.spymasterStreak = 0;

      // track how many times this user has lead their team to click on the
      // assassin as spymaster
      if (game.blueAgents > 0 && game.redAgents > 0) {
        user.assassinsAsSpymaster++;
      }
    }
  }
}

/**
 * Given the number of games a user has played, make the eloChange more drastic
 * the further they are from getting out of the provisional period. Earlier
 * games affect your elo rating more than later games.
 */
function deltaWithProvisional(gamesPlayed: number, eloChange: number): number {
  const multiplier = gamesPlayed < PROVISIONAL_GAMES ?
      Math.ceil((PROVISIONAL_GAMES - gamesPlayed) / 2) :
      1;
  return eloChange * multiplier;
}

export async function nukeEloHistoryForGame(
    db: any, gameId: string): Promise<void[]> {
  const snapshot =
      await db.collection('eloHistory').where('gameId', '==', gameId).get();

  // delete every document with a timestamp >= to the one provided
  // wait for every snapshot to be removed before continuing
  return await Promise.all(
      snapshot.docs.map((doc: firestore.DocumentSnapshot) => {
        return removeEloHistoryRecord(db, doc.id);
      }));
}

function removeEloHistoryRecord(db: any, docId: string): Promise<void> {
  return db.collection('eloHistory').doc(docId).delete();
}

function getTeamElo(team: Team, userMap: UserMap) {
  // TODO: fancier team ratings for the delta changes, right now just average
  let totalElo = 0;
  for (const userId of team.userIds) {
    totalElo += userMap[userId].elo || BASE_ELO;
  }
  return totalElo / team.userIds.length;
}