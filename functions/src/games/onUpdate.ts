import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import {DocumentSnapshot} from 'firebase-functions/lib/providers/firestore';

import {Game, GameStatus, TileRole, User} from '../../../types';

const db = admin.firestore();

export const onUpdateGame =
    functions.firestore.document('games/{gameId}')
        .onUpdate(async (gameDoc, context) => {
          await updateRemainingAgents(gameDoc.after);
          await determineGameOver(gameDoc.before, gameDoc.after);

          return 'Done';
        });

async function updateRemainingAgents(snapshot: DocumentSnapshot):
    Promise<void> {
  const game = snapshot.data() as Game;

  if (game.tiles) {
    let blueAgents = 0;
    let redAgents = 0;

    // determine the remaining blue and red agents
    game.tiles.forEach(tile => {
      if (tile.selected === false) {
        if (tile.role === TileRole.BLUE) {
          blueAgents++;
        } else if (tile.role === TileRole.RED) {
          redAgents++;
        }
      }
    });

    // only update when the # of remaining agents goes down
    if (blueAgents < game.blueAgents || redAgents < game.redAgents) {
      const updates: Partial<Game> = {blueAgents, redAgents};

      // determine if the team won by getting all of their clues
      if (blueAgents === 0) {
        updates.status = GameStatus.BLUE_WON;
        updates.completedAt = Date.now();
      }
      if (redAgents === 0) {
        updates.status = GameStatus.RED_WON;
        updates.completedAt = Date.now();
      }

      await snapshot.ref.update(updates);
    }
  }
}

async function determineGameOver(
    before: DocumentSnapshot, after: DocumentSnapshot) {
  const preGameUpdate = before.data() as Game;
  const postGameUpdate = after.data() as Game;

  // Check if the last update was the game completing
  if (!preGameUpdate.completedAt && postGameUpdate.completedAt) {
    // Process Endgame analytics
    const gameId = before.id;
    for (const user of postGameUpdate.blueTeam.userIds) {
      await calculatePlayerStats(
          user, postGameUpdate.status === GameStatus.BLUE_WON, gameId);
    }
    for (const user of postGameUpdate.redTeam.userIds) {
      await calculatePlayerStats(
          user, postGameUpdate.status === GameStatus.RED_WON, gameId);
    }
  }
}

async function calculatePlayerStats(
    userId: string, wonGame: Boolean, gameId: string) {
  const userSnapshot = await db.collection('users').doc(userId);
  let playerUpdate;
  if (wonGame) {
    playerUpdate = {
      'stats.currentStreak': admin.firestore.FieldValue.increment(1),
      'stats.gamesWon': admin.firestore.FieldValue.increment(1),
      'stats.gamesPlayed': admin.firestore.FieldValue.increment(1)
    };
  } else {
    playerUpdate = {
      'stats.currentStreak': 0,
      'stats.gamesWon': admin.firestore.FieldValue.increment(0),
      'stats.gamesPlayed': admin.firestore.FieldValue.increment(1)
    };
  }
  userSnapshot.update(playerUpdate).catch(err => console.error(err))

  const user = (await userSnapshot.get()).data() as User;

  const currentElo = {
    elo: 0,  // TODO
    gameId,
    gamesPlayed: user.stats.gamesPlayed,
    gamesWon: user.stats.gamesWon,
    playerId: user.id,
    provisional: false
  };

  const eloSnapshot = await db.collection('elohistory').doc('default');

  return eloSnapshot.create(currentElo);
}
