import { Server as SocketIOServer } from 'socket.io';
import { attachAuthenticationMiddleware } from '../middleware/socketMiddleware';
import { findUserById } from './usersService';
import { getGameState, createGame, deleteGameState } from './gameManager';

export const setupWebSocket = (httpServer: any) => {
  const CLIENT_URL = process.env.CLIENT_ORIGIN;
  
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: CLIENT_URL,
      methods: ["GET", "POST"],
      allowedHeaders: ["my-custom-header"],
      credentials: true
    }
  });

  // Attach the authentication middleware
  attachAuthenticationMiddleware(io);

  const lobbyUsers: { [key: string]: any } = {};
  const userToSocketIdMap: { [userId: string]: string } = {}; // Map of user ID to socket ID

  io.on('connection', async (socket): Promise<void> => {
    if (socket.user?.id) {
      // Add the user's socket ID to the mapping
      userToSocketIdMap[socket.user.id] = socket.id;
    }

    socket.on('join_pvp_lobby', async (data) => {
      const { userId } = data;

      try {
        const user = await findUserById(userId);
        if (user) {
          lobbyUsers[userId] = { id: user.id, username: user.username, socketId: socket.id, inPendingChallenge: false};
        }
      } catch (error) {
        console.error('Error fetching user from database:', error);
      }
      io.emit('update_lobby', lobbyUsers);
    });

    socket.on('leave_pvp_lobby', async (data) => {
      const { userId } = data;
      delete lobbyUsers[userId];
      io.emit('update_lobby', lobbyUsers);
    });

    socket.on('request_lobby_update', () => {
      io.emit('update_lobby', lobbyUsers);
    });

    socket.on('request_challenge', async (data) => {
      const { challengedUserId, challengerUserId } = data;
      
      if (lobbyUsers.hasOwnProperty(challengedUserId)) {
        const challengedUser = lobbyUsers[challengedUserId];
        const challengerUserSocketId = userToSocketIdMap[challengerUserId];
    
        // Check if the challenged user is already in a pending challenge
        if (challengedUser.inPendingChallenge) {
          if (challengerUserSocketId) {
            io.to(challengerUserSocketId).emit('challenge_unavailable', {
              message: 'User is currently unavailable for challenges.'
            });
          }
        } else {
          const challengedUserSocketId = userToSocketIdMap[challengedUserId];
          
          if (challengedUserSocketId) {
            console.log(`Sending challenge to ${challengedUserId}`);
            io.to(challengedUserSocketId).emit('challenge_received', {
              challengerUserId,
              challengerUsername: lobbyUsers[challengerUserId].username
            });
    
            lobbyUsers[challengedUserId].inPendingChallenge = true;
            lobbyUsers[challengerUserId].inPendingChallenge = true;
    
            io.emit('update_lobby', lobbyUsers);
          }
        }
      } else {
        console.log('Challenged user not found in lobby');
      }
    });
    

    socket.on('accept_challenge', async (data) => {
      const { challengedUserId, challengerUserId } = data;
    
      // Check if both the challenger and the challenged user are in the lobby
      if (lobbyUsers.hasOwnProperty(challengerUserId) && lobbyUsers.hasOwnProperty(challengedUserId)) {
        const challengerUserSocketId = userToSocketIdMap[challengerUserId];
        const challengedUserSocketId = userToSocketIdMap[challengedUserId];
    
        // Ensure that both users have valid socket IDs
        if (challengerUserSocketId && challengedUserSocketId) {
          // Create a new room for the game
          const roomId = `room-${challengerUserId}-${challengedUserId}`;
          
          // Initialize or update the game state for this room
          createGame(roomId, [challengerUserId, challengedUserId]);
    
          // Join both the challenger and the challenged user to the room
          io.sockets.sockets.get(challengerUserSocketId)?.join(roomId);
          io.sockets.sockets.get(challengedUserSocketId)?.join(roomId);
    
          // Notify both users about the room creation
          io.to(roomId).emit('room_ready', { roomId });
          io.to(roomId).emit('challenge_accepted')
    
          // Remove users from the lobbyUsers object
          delete lobbyUsers[challengerUserId];
          delete lobbyUsers[challengedUserId];
    
          // Update the lobby for all users
          io.emit('update_lobby', lobbyUsers);
        } else {
          console.log(`One of the users does not have a valid socket ID`);
        }
      } else {
        console.log('One of the users is not found in the lobby');
      }
    });

    socket.on('cancel_challenge', (data) => {
      const { challengedUserId, challengerUserId } = data;
     
      lobbyUsers[challengedUserId].inPendingChallenge = false;
      lobbyUsers[challengerUserId].inPendingChallenge = false;
  
      io.emit('update_lobby', lobbyUsers);
      io.to(userToSocketIdMap[challengedUserId]).emit('challenge_canceled', { challengerUserId, message: 'Challenger has canceled the challenge request' });
  });
  

    socket.on('reject_challenge', (data) => {
      const { challengedUserId, challengerUserId } = data;
      
      lobbyUsers[challengedUserId].inPendingChallenge = false;
      lobbyUsers[challengerUserId].inPendingChallenge = false;

      io.emit('update_lobby', lobbyUsers);
      io.to(userToSocketIdMap[challengerUserId]).emit('challenge_rejected', { challengedUserId, message: 'Challenge rejected' });
    });

    
  socket.on('player_ready', async (data) => {
    const { playerId, roomId, ships } = data;
    const gameState = getGameState(roomId);

    let username;

    if (gameState) {
      gameState.setPlayerReady(playerId);

      gameState.updateBoard(playerId, undefined, ships);

      // Notify the room that this player is ready
      try {
        const user = await findUserById(playerId);
        if (user) {
         username = user.username;
        }
      } catch (error) {
        console.error('Error fetching user from database:', error);
      }

      // get opponent socket id
      const opponent = gameState.getOpponent(playerId);
      const opponentSocketId = opponent ? userToSocketIdMap[opponent]! : undefined!;

      io.to(opponentSocketId).emit('opponent_ready', { username });

      // Check if all players are ready
      if (gameState.allPlayersReady()) {
        // Emit an event to signal both players to move to the game room
        gameState.currentTurn = gameState.chooseRandomPlayer();
        let currentPlayerTurn = gameState.currentTurn;
        io.to(roomId).emit('all_players_ready', { roomId, currentPlayerTurn });
      }
    }
  });

  socket.on('reset_ships', (data) => {
    const { playerId, roomId } = data;
    const gameState = getGameState(roomId);
    const opponent = gameState?.getOpponent(playerId);
    const opponentSocketId = opponent ? userToSocketIdMap[opponent]! : undefined!;


    if (gameState && gameState?.checkIfPlayerReady(playerId)) {
      gameState.updateBoard(playerId, undefined, {});
      io.to(opponentSocketId).emit('opponent_reset', { playerId });
    }
  });

  socket.on('shot_called', async (data) => {
    const { square, roomId, currentPlayerId } = data;
    const gameState = getGameState(roomId);


    if (gameState && square && currentPlayerId !== undefined) {
      const opponent = gameState.getOpponent(currentPlayerId);

      // Check if the move has already been processed
      if (gameState.isMoveProcessed(currentPlayerId, square)) {
        return; // Ignore the shot if it has been processed
      }

      if (gameState.checkIfHit(opponent, square)) {
        if(gameState.checkIfSunk(opponent, square)) {
          let ship = gameState.getSunkShip(opponent);

          if(gameState.checkIfAllShipsSunk(opponent)) {
            let username;
            gameState.switchPlayerTurn();
            let currentPlayerTurn = gameState.currentTurn;
            try {
              const user = await findUserById(currentPlayerId);
              if (user) {
               username = user.username;
              }
            } catch (error) {
              console.error('Error fetching user from database:', error);
            }

            io.to(roomId).emit('ship_sunk', { square, currentPlayerTurn, ship });
            io.to(roomId).emit('game_over', { winner: username, winnerId: currentPlayerId, message: '' });
            
            deleteGameState(roomId);

          } else {
              gameState.switchPlayerTurn();
              let currentPlayerTurn = gameState.currentTurn;
              io.to(roomId).emit('ship_sunk', { square, currentPlayerTurn, ship });
          }

        } else {
          gameState.switchPlayerTurn();
          let currentPlayerTurn = gameState.currentTurn;
          io.to(roomId).emit('shot_hit', { square, currentPlayerTurn });
        }
      } else {
        gameState.updateBoard(opponent, square)
        gameState.switchPlayerTurn();
        let currentPlayerTurn = gameState.currentTurn;
        io.to(roomId).emit('shot_miss', { square, currentPlayerTurn });
      }

      gameState.markMoveAsProcessed(currentPlayerId, square);
    }
  });

  socket.on('rejoin_game_room', async (data) => {
    console.log('rejoin_game_room event received');
    const { userId, roomId } = data;
    const gameState = getGameState(roomId);

    if (gameState && gameState.hasPlayer(userId)) {
        // Use the current socket instance to join the room
        socket.join(roomId);
        console.log(`User ${userId} rejoined room ${roomId}`);

        // Update the mapping of the user ID to the new socket ID
        userToSocketIdMap[userId] = socket.id;

        // Emit events or send messages as needed to synchronize game state
        // For example, sending current game state to the reconnected user
        const userSocketId = userToSocketIdMap[userId];
        io.to(userSocketId).emit('rejoined_game_room', { currentTurn: gameState.currentTurn });
    }
});

  socket.on('get_current_users_board', async (data) => {
    const { roomId, playerId } = data;
    const gameState = getGameState(roomId);
    const userSocketId = userToSocketIdMap[playerId];

    if (gameState) {
      const playerBoard = gameState.playerBoards[playerId];
      io.to(userSocketId).emit('current_users_board', { hits: playerBoard.hits, misses: playerBoard.misses});
    }
  });

  socket.on('get_opponents_board', async (data) => {
    const { roomId, playerId } = data;
    const gameState = getGameState(roomId);
    const userSocketId = userToSocketIdMap[playerId];

    if (gameState) {
      const opponent = gameState.getOpponent(playerId);
      const opponentBoard = gameState.playerBoards[opponent];
      io.to(userSocketId).emit('opponents_board', { hits: opponentBoard.hits, misses: opponentBoard.misses});
    }
  });

  socket.on('leave_game', async (data) => {
    const { roomId, playerId, currentRoom } = data;
    const gameState = getGameState(roomId);
    const opponent = gameState?.getOpponent(playerId);
    const opponentSocketId = opponent ? userToSocketIdMap[opponent]! : undefined!;

    if (gameState) {
      // Remove the player from the game state
      gameState.removePlayer(playerId);

      // If the opponent is still in the room, notify them that they won
      if (opponent && currentRoom === '/game-room') {
        let username;
        try {
          const user = await findUserById(opponent);
          if (user) {
            username = user.username;
          }
        } catch (error) {
          console.error('Error fetching user from database:', error);
        }

        io.to(roomId).emit('game_over', { winner: username, winnerId: opponent, message: 'Opponent left - ' });
      } else {
        io.to(opponentSocketId).emit('game_cancelled', { message: 'Opponent left before the game started - No winner' });
      }

      // Delete the game state if both players have left
      if (gameState.players.length === 0) {
        deleteGameState(roomId);
      }
    }
    
  });

    socket.on('disconnect', () => {
      if (socket.user?.id) {
        console.log(`user ${socket.user.id} disconnected`);
        delete lobbyUsers[socket.user.id];
        delete userToSocketIdMap[socket.user.id]; // Remove from user-to-socket mapping
      }
      io.emit('lobbyUpdate', lobbyUsers);
    });
  });
};
