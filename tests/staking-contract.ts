import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { StakingContract } from "../target/types/staking_contract";

import * as spl from "@solana/spl-token";
import { assert, expect } from "chai";

interface PDAParameters {
  stake_pool: anchor.web3.PublicKey;
  pool_action: anchor.web3.PublicKey;
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

describe("Stake", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakingContract as Program<StakingContract>;

  let mintAddress: anchor.web3.PublicKey;

  let alice: anchor.web3.Keypair;
  // let bob: anchor.web3.Keypair;
  let aliceTokenAccount: anchor.web3.PublicKey;
  // let bobTokenAccount: anchor.web3.PublicKey;

  let pda: PDAParameters;

  let stakingVaultAssociatedAddress: anchor.web3.PublicKey;

  //get PDA of Stake Pool
  const getPdaParams = async (
    token_program: anchor.web3.PublicKey,
    signer: anchor.web3.PublicKey
  ): Promise<PDAParameters> => {
    let [stake_pool, stake_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("stake_pool"), token_program.toBuffer()],
        program.programId
      );

    let [pool_action, pool_action_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("pool_action"), signer.toBuffer()],
        program.programId
      );
    return {
      stake_pool: stake_pool,
      pool_action: pool_action,
    };
  };

  //get PDAs of Staking Entry
  const getPdaStakingEntries = async (
    signer: anchor.web3.PublicKey
  ): Promise<EntriesPDA> => {
    let s_last_count = await getLastEntryCount(signer);
    let last_count = parseInt(s_last_count);

    let keys = [];

    while (last_count != 0) {
      let [pool_entry_account, pool_entry_account_bump] =
        await anchor.web3.PublicKey.findProgramAddress(
          [
            Buffer.from("pool_entry"),
            signer.toBuffer(),
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
    signer: anchor.web3.PublicKey
  ): Promise<string> => {
    let [pool_count, pool_count_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("pool_count"), signer.toBuffer()],
        program.programId
      );

    try {
      let count = await program.account.count.fetch(pool_count);
      let last_count = count.count;

      return last_count.toString();
    } catch (ex) {
      return "0".toString();
    }
  };

  const getEntryCountPDA = async (
    signer: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> => {
    let [pool_count, pool_count_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("pool_count"), signer.toBuffer()],
        program.programId
      );

    return pool_count;
  };

  //Get PDA For storing the Entry
  const getLatestEntryPDA = async (
    signer: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey> => {
    let last_count = await getLastEntryCount(signer);
    let next_count = (parseInt(last_count) + 1).toString();
    let [last_entry_pda, pda_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("pool_entry"),
          signer.toBuffer(),
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

    // [bob, bobTokenAccount] = await createUserAndAssociatedWallet(
    //   mintAddress,
    //   20000000
    // );

    // PDA for alice
    pda = await getPdaParams(mintAddress, alice.publicKey);
    //check before calling program
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, "20000000");

    stakingVaultAssociatedAddress = await spl.getAssociatedTokenAddress(
      mintAddress,
      pda.stake_pool,
      true,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it("Staking", async () => {
    let staking_amount = "20000000";
    let staking_token = mintAddress;
    let stake_action = true; //Deposite

    console.log("here");

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey);
    let latest_count = await getLastEntryCount(alice.publicKey);

    console.log("pool_entry_pda", pool_entry_pda);
    console.log("pool_count_pda", pool_count_pda);

    let next_count = parseInt(latest_count) + 1;
    let txn = await program.rpc.performAction(
      new anchor.BN(staking_amount),
      staking_token,
      stake_action,
      new anchor.BN(next_count),
      {
        accounts: {
          staker: alice.publicKey,
          tokenMint: mintAddress,
          currentStakingPool: pda.stake_pool,
          poolAction: pda.pool_action,
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
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, "0");

    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, staking_amount);
  });

  it("Unstaking", async () => {
    let un_staking_amount = "5000000";
    let staking_token = mintAddress;
    let stake_action = false;

    let pool_entry_pda = await getLatestEntryPDA(alice.publicKey);
    let pool_count_pda = await getEntryCountPDA(alice.publicKey);
    let latest_count = await getLastEntryCount(alice.publicKey);

    let next_count = parseInt(latest_count) + 1;

    let txn = await program.rpc.performAction(
      new anchor.BN(un_staking_amount),
      staking_token,
      stake_action,
      next_count,
      {
        accounts: {
          staker: alice.publicKey,
          tokenMint: mintAddress,
          currentStakingPool: pda.stake_pool,
          poolAction: pda.pool_action,
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
    assert.equal(stakingVaultBalance, "15000000");

    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, un_staking_amount);
  });

  it("Get Entry Data", async () => {
    let entires = await getPdaStakingEntries(alice.publicKey);

    console.log("Entires PDA", Array.from(entires.entries_pda));

    await entires.entries_pda.forEach(async (element, i) => {
      let string_pub_key = element.toString();
      let pub_key = new anchor.web3.PublicKey(string_pub_key);
      let data_from_pda = await getEntryData(pub_key);
      console.log("Entry Count", i);
      console.log("Data Action", data_from_pda.action);
      console.log("Data Amount", data_from_pda.amount.toString());
      console.log("Data User", data_from_pda.staker.toString());
      console.log("Data Timestamp", data_from_pda.time.toString());
    });
  });
});
