import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { StakingContract } from '../target/types/staking_contract';

import * as spl from '@solana/spl-token';
import { assert, expect } from 'chai';

interface PDAParameters {
  stake_pool: anchor.web3.PublicKey;
  pool_action: anchor.web3.PublicKey;
  lock_pool: anchor.web3.PublicKey;
  withdraw_pool: anchor.web3.PublicKey;
}
interface EntriesPDA {
  entries_pda: [anchor.web3.PublicKey];
}

interface EntriesData {
  staker;
  amount;
  action;
  time;
}

describe('Test Stake Unstake etc', () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakingContract as Program<StakingContract>;

  let mintAddress: anchor.web3.PublicKey;

  let alice: anchor.web3.Keypair;
  let bobAdmin: anchor.web3.Keypair;
  let aliceTokenAccount: anchor.web3.PublicKey;
  let bobAdminTokenAccount: anchor.web3.PublicKey;

  let adminConfig: anchor.web3.PublicKey;

  let pda: PDAParameters;

  let stakingVaultAssociatedAddress: anchor.web3.PublicKey;

  const fundWallet = async (user: anchor.web3.PublicKey, amount: number) => {
    let txFund = new anchor.web3.Transaction();
    txFund.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: user,
        lamports: amount * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    const sigTxFund = await provider.sendAndConfirm(txFund);
  };

  //get PDA of Stake Pool
  const getPdaParams = async (
    token_program: anchor.web3.PublicKey,
    signer: anchor.web3.PublicKey
  ): Promise<PDAParameters> => {
    let [stake_pool, stake_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from('stake_pool'), token_program.toBuffer()],
        program.programId
      );

    let [pool_action, pool_action_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from('pool_action'),
          signer.toBuffer(),
          token_program.toBuffer(),
        ],
        program.programId
      );

    let [lock_pool_action, lock_pool_action_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from('lock_pool_action'),
          signer.toBuffer(),
          token_program.toBuffer(),
        ],
        program.programId
      );

    let [withdraw_pool_action, withdraw_pool_action_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from('withdraw_pool_action'),
          signer.toBuffer(),
          token_program.toBuffer(),
        ],
        program.programId
      );

    return {
      stake_pool: stake_pool,
      pool_action: pool_action,
      lock_pool: lock_pool_action,
      withdraw_pool: withdraw_pool_action,
    };
  };

  //get PDAs of Staking Entry
  const getPdaStakingEntries = async (
    signer: anchor.web3.PublicKey,
    token_mint: anchor.web3.PublicKey
  ): Promise<EntriesPDA> => {
    let s_last_count = await getLastEntryCount(signer, token_mint);
    let last_count = parseInt(s_last_count);

    let keys = [];

    while (last_count != 0) {
      let [pool_entry_account, pool_entry_account_bump] =
        await anchor.web3.PublicKey.findProgramAddress(
          [
            Buffer.from('pool_entry'),
            signer.toBuffer(),
            token_mint.toBuffer(),
            new anchor.BN(last_count).toArrayLike(Buffer),
          ],
          program.programId
        );

      keys.push(pool_entry_account);
      last_count -= 1;
    }

    return {
      entries_pda: keys,
    };
  };

  //get last entry of the user
  const getLastEntryCount = async (
    signer: anchor.web3.PublicKey,
    token_mint: anchor.web3.PublicKey
  ): Promise<string> => {
    let [pool_count, pool_count_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from('pool_count'), signer.toBuffer(), token_mint.toBuffer()],
        program.programId
      );

    try {
      let count = await program.account.count.fetch(pool_count);
      let last_count = count.count;

      return last_count.toString();
    } catch (ex) {
      return '0'.toString();
    }
  };

  const getEntryCountPDA = async (
    signer: anchor.web3.PublicKey,
    action_token: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> => {
    let [pool_count, pool_count_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from('pool_count'), signer.toBuffer(), action_token.toBuffer()],
        program.programId
      );

    return pool_count;
  };

  //Get PDA For storing the Entry
  const getLatestEntryPDA = async (
    signer: anchor.web3.PublicKey,
    token_mint: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> => {
    let last_count = await getLastEntryCount(signer, token_mint);
    let next_count = (parseInt(last_count) + 1).toString();
    let [last_entry_pda, pda_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from('pool_entry'),
          signer.toBuffer(),
          token_mint.toBuffer(),
          new anchor.BN(next_count).toArrayLike(Buffer),
        ],
        program.programId
      );

    return last_entry_pda;
  };

  //Get Entry Data
  const getEntryData = async (
    pdaKey: anchor.web3.PublicKey
  ): Promise<EntriesData> => {
    let entry = await program.account.poolActionEntry.fetch(pdaKey);
    return {
      staker: entry.staker,
      amount: entry.tokenAmount,
      action: entry.stakeAction,
      time: entry.timeStamp,
      confirmed: entry.confirmed,
    };
  };

  //Create a SPL Token
  const createMint = async (): Promise<anchor.web3.PublicKey> => {
    const tokenMint = new anchor.web3.Keypair();
    const lamportsForMint =
      await provider.connection.getMinimumBalanceForRentExemption(
        spl.MintLayout.span
      );
    let tx = new anchor.web3.Transaction();

    // Allocate mint
    tx.add(
      anchor.web3.SystemProgram.createAccount({
        programId: spl.TOKEN_PROGRAM_ID,
        space: spl.MintLayout.span,
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: tokenMint.publicKey,
        lamports: lamportsForMint,
      })
    );
    // Allocate wallet account
    tx.add(
      spl.createInitializeMintInstruction(
        tokenMint.publicKey,
        6,
        provider.wallet.publicKey,
        provider.wallet.publicKey,
        spl.TOKEN_PROGRAM_ID
      )
    );
    const signature = await provider.sendAndConfirm(tx, [tokenMint]);

    // console.log(`[${tokenMint.publicKey}] Created new mint account at ${signature}`);
    return tokenMint.publicKey;
  };

  //Create a User Associated Wallet for SPL Tokens
  const createUserAndAssociatedWallet = async (
    mint: anchor.web3.PublicKey,
    amount: number
  ): Promise<[anchor.web3.Keypair, anchor.web3.PublicKey | undefined]> => {
    const user = new anchor.web3.Keypair();
    let userAssociatedTokenAccount: anchor.web3.PublicKey | undefined =
      undefined;

    // Fund user with some SOL
    let txFund = new anchor.web3.Transaction();
    txFund.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: user.publicKey,
        lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    const sigTxFund = await provider.sendAndConfirm(txFund);

    if (mint) {
      // Create a token account for the user and mint some tokens
      userAssociatedTokenAccount = await spl.getAssociatedTokenAddress(
        mint,
        user.publicKey,
        false,
        spl.TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const txFundTokenAccount = new anchor.web3.Transaction();
      txFundTokenAccount.add(
        spl.createAssociatedTokenAccountInstruction(
          user.publicKey,
          userAssociatedTokenAccount,
          user.publicKey,
          mint,
          spl.TOKEN_PROGRAM_ID,
          spl.ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      txFundTokenAccount.add(
        spl.createMintToInstruction(
          mint,
          userAssociatedTokenAccount,
          provider.wallet.publicKey,
          amount,
          [],
          spl.TOKEN_PROGRAM_ID
        )
      );
      const txFundTokenSig = await provider.sendAndConfirm(txFundTokenAccount, [
        user,
      ]);
      // console.log(`[${userAssociatedTokenAccount.toBase58()}] New associated account for mint ${mint.toBase58()}: ${txFundTokenSig}`);
    }
    return [user, userAssociatedTokenAccount];
  };

  const getAdminPDA = async (): Promise<anchor.web3.PublicKey> => {
    const adminConfig = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from('admin_config')],
      program.programId
    );
    return adminConfig[0];
  };

  const getTokenInterestPDA = async (
    token_mint: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> => {
    const tokenInterest = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from('token_interest'), token_mint.toBuffer()],
      program.programId
    );

    return tokenInterest[0];
  };

  const readAccount = async (
    accountPublicKey: anchor.web3.PublicKey
  ): Promise<[string]> => {
    const tokenInfoLol = await provider.connection.getAccountInfo(
      accountPublicKey
    );
    const data = Buffer.from(tokenInfoLol.data);
    const accountInfo: spl.AccountInfo = spl.AccountLayout.decode(data);
    return accountInfo.amount.toString();
  };

  before(async () => {
    //c8 mint token
    mintAddress = await createMint();
    //transfer token to alice
    [alice, aliceTokenAccount] = await createUserAndAssociatedWallet(
      mintAddress,
      20000000
    );

    [bobAdmin, bobAdminTokenAccount] = await createUserAndAssociatedWallet(
      mintAddress,
      0
    );

    // PDA for alice
    pda = await getPdaParams(mintAddress, alice.publicKey);
    //check before calling program
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, '20000000');

    stakingVaultAssociatedAddress = await spl.getAssociatedTokenAddress(
      mintAddress,
      pda.stake_pool,
      true,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it('Update Admin on Config', async () => {
    adminConfig = await getAdminPDA();

    let tempAdmin = new anchor.web3.Keypair();
    await fundWallet(tempAdmin.publicKey, 2);

    await program.rpc.updateAdminWallet(tempAdmin.publicKey, {
      accounts: {
        owner: tempAdmin.publicKey,
        adminConfig: adminConfig,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [tempAdmin],
    });

    let info = await program.account.config.fetch(adminConfig);
    assert.equal(info.admin.toString(), tempAdmin.publicKey.toString());

    await program.rpc.updateAdminWallet(bobAdmin.publicKey, {
      accounts: {
        owner: tempAdmin.publicKey,
        adminConfig: adminConfig,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [tempAdmin],
    });

    info = await program.account.config.fetch(adminConfig);
    assert.equal(info.admin.toString(), bobAdmin.publicKey.toString());
  });

  it('Update Interest Rate', async () => {
    // Update Interest Rate
    let tokenInterestPda = await getTokenInterestPDA(mintAddress);

    let interestRate = 2;

    let txn = await program.rpc.updateInterestRate(interestRate, {
      accounts: {
        admin: bobAdmin.publicKey,
        tokenInterest: tokenInterestPda,
        adminConfig: adminConfig,
        tokenMint: mintAddress,
        associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [bobAdmin],
    });

    let tokenInterest = await program.account.interestRate.fetch(
      tokenInterestPda
    );
    assert.equal(tokenInterest.interest.toString(), '2');
  });

  it('Staking1', async () => {
    let staking_amount = '10000000';
    let stake_action = true; //Deposite

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey, mintAddress);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey, mintAddress);
    let latest_count = await getLastEntryCount(alice.publicKey, mintAddress);
    let tokenInterestPda = await getTokenInterestPDA(mintAddress);

    let next_count = parseInt(latest_count) + 1;
    let txn = await program.rpc.performAction(
      new anchor.BN(staking_amount),
      mintAddress,
      stake_action,
      new anchor.BN(next_count),
      {
        accounts: {
          staker: alice.publicKey,
          currentStakingPool: pda.stake_pool,
          poolAction: pda.pool_action,
          lockPoolAction: pda.lock_pool,
          withdrawPoolAction: pda.withdraw_pool,
          poolEntry: pool_entry_pda,
          poolCount: pool_count_pda,
          tokenInterest: tokenInterestPda,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          stakerAssociatedAddress: aliceTokenAccount,
          tokenMint: mintAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [alice],
      }
    );
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, staking_amount);

    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, staking_amount);
  });

  it('Staking2', async () => {
    let staking_amount = '10000000';
    let stake_action = true; //Deposite

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey, mintAddress);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey, mintAddress);
    let latest_count = await getLastEntryCount(alice.publicKey, mintAddress);
    let tokenInterestPda = await getTokenInterestPDA(mintAddress);

    let next_count = parseInt(latest_count) + 1;
    let txn = await program.rpc.performAction(
      new anchor.BN(staking_amount),
      mintAddress,
      stake_action,
      new anchor.BN(next_count),
      {
        accounts: {
          staker: alice.publicKey,
          currentStakingPool: pda.stake_pool,
          poolAction: pda.pool_action,
          lockPoolAction: pda.lock_pool,
          withdrawPoolAction: pda.withdraw_pool,
          poolEntry: pool_entry_pda,
          poolCount: pool_count_pda,
          tokenInterest: tokenInterestPda,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          stakerAssociatedAddress: aliceTokenAccount,
          tokenMint: mintAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [alice],
      }
    );
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, '0');

    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, staking_amount * 2);
  });

  it('Withdraw Request', async () => {
    let un_staking_amount = '500000';
    let stake_action = false;

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey, mintAddress);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey, mintAddress);
    let latest_count = await getLastEntryCount(alice.publicKey, mintAddress);
    let tokenInterestPda = await getTokenInterestPDA(mintAddress);

    let next_count = parseInt(latest_count) + 1;

    let txn = await program.rpc.performAction(
      new anchor.BN(un_staking_amount),
      mintAddress,
      stake_action,
      next_count,
      {
        accounts: {
          staker: alice.publicKey,
          currentStakingPool: pda.stake_pool,
          poolAction: pda.pool_action,
          lockPoolAction: pda.lock_pool,
          withdrawPoolAction: pda.withdraw_pool,
          poolEntry: pool_entry_pda,
          poolCount: pool_count_pda,
          tokenInterest: tokenInterestPda,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          stakerAssociatedAddress: aliceTokenAccount,
          tokenMint: mintAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [alice],
      }
    );
    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, '20000000');

    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, '0');
  });

  it('Withdraw Token On Sunday', async () => {
    let un_staking_amount = '5000000';
    let stake_action = false;

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey, mintAddress);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey, mintAddress);
    let latest_count = await getLastEntryCount(alice.publicKey, mintAddress);
    let tokenInterestPda = await getTokenInterestPDA(mintAddress);

    let next_count = parseInt(latest_count) + 1;

    let txn = await program.rpc.claimWithdraw(
      new anchor.BN(un_staking_amount),
      next_count,
      {
        accounts: {
          staker: alice.publicKey,
          tokenMint: mintAddress,
          currentStakingPool: pda.stake_pool,
          withdrawPoolAction: pda.withdraw_pool,
          poolEntry: pool_entry_pda,
          poolCount: pool_count_pda,
          stakerAssociatedAddress: aliceTokenAccount,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [alice],
      }
    );
    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, '15000000');

    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, un_staking_amount);
  });

  it('Withdraw Token By Admin', async () => {
    let withdraw_amount = '199999';
    let txn = await program.rpc.rescuseToken(new anchor.BN(withdraw_amount), {
      accounts: {
        owner: bobAdmin.publicKey,
        currentStakingPool: pda.stake_pool,
        adminConfig: adminConfig,
        stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
        adminAssociatedAddress: bobAdminTokenAccount,
        tokenMint: mintAddress,
        associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      },
      signers: [bobAdmin],
    });

    let adminBalance = await readAccount(bobAdminTokenAccount);
    assert.equal(adminBalance, withdraw_amount);
  });

  it('Get Deposit/Withdraw Entry Data', async () => {
    let entires = await getPdaStakingEntries(alice.publicKey, mintAddress);

    await entires.entries_pda.forEach(async (element, i) => {
      let string_pub_key = element.toString();
      let pub_key = new anchor.web3.PublicKey(string_pub_key);
      let data_from_pda = await getEntryData(pub_key);
      console.log('===>', i);
      console.log('Entry Count', i);
      console.log('Data Action', data_from_pda.action);
      console.log('Data Amount', data_from_pda.amount.toString());
      console.log('Data User', data_from_pda.staker.toString());
      console.log('Data Timestamp', data_from_pda.time.toString());
      console.log('Data Confirmed ', data_from_pda.confirmed.toString());
    });
  });
});
