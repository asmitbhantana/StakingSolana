use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 

    token::{ Token, Transfer, TokenAccount, Mint}
};
use anchor_lang::require;
use anchor_lang::prelude::Clock;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod staking_contract {
    use super::*;

    pub fn perform_action(
        ctx: Context<PerformAction>,
        action_amount: u64, 
        action_token: Pubkey,
        stake_action: bool,
        count: u8
    ) -> Result<()> {
       let current_user = ctx.accounts.staker.clone();
       let token_program = ctx.accounts.token_mint.clone();
    
       let token_mint_key = ctx.accounts.token_mint.clone().key();
       let current_staking_pool_account = ctx.accounts.current_staking_pool.clone().to_account_info();
       let staking_pool = &mut ctx.accounts.current_staking_pool;
       let pool_action = &mut ctx.accounts.pool_action;

       let pool_action_entry = &mut ctx.accounts.pool_entry;
       let pool_count = &mut ctx.accounts.pool_count;

       require!(token_program.key() == action_token, ErrorCode::InvalidToken);  

       if stake_action {

        pool_action.staker = current_user.key();
        pool_action.token_amount += action_amount;
        pool_action.start_time = 7u64; //For testing

        let transfer_instruction = Transfer{
            from: ctx.accounts.staker_associated_address.to_account_info(),
            to: ctx.accounts.staking_vault_associated_address.to_account_info(),
            authority: ctx.accounts.staker.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
        );
        anchor_spl::token::transfer(cpi_ctx, action_amount)?;

        staking_pool.token_amount += action_amount;
       }

       else {
        
        require!(pool_action.staker == ctx.accounts.staker.key(), ErrorCode::InvalidUser);
        require!(pool_action.token_amount >= action_amount && staking_pool.token_amount >= action_amount, ErrorCode::NotEnoughToken);

        pool_action.token_amount -= action_amount;

         let bump_seed_staking_pool = ctx.bumps.get("current_staking_pool").unwrap().to_le_bytes();
         let staking_pool_signer_seeds: &[&[_]] = &[
            b"stake_pool".as_ref(),
            &token_mint_key.as_ref(),
            &bump_seed_staking_pool
        ];

        let transfer_instruction = Transfer{
            from: ctx.accounts.staking_vault_associated_address.to_account_info(),
            to: ctx.accounts.staker_associated_address.to_account_info(),
            authority: current_staking_pool_account.clone(),
        };
        let signer = &[staking_pool_signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
            signer,
            );
        anchor_spl::token::transfer(cpi_ctx, action_amount)?;

        staking_pool.token_amount -= action_amount;
        
       }

        pool_action_entry.stake_action = stake_action;
        pool_action_entry.staker = current_user.key();
        pool_action_entry.token_amount = action_amount;
        pool_action_entry.time_stamp =Clock::get()?.unix_timestamp;

        pool_count.count = count;

       Ok(())
    }
}

#[derive(Accounts)]
#[instruction(action_amount: u64, action_token: Pubkey, stake_action: bool, count: u8)]
pub struct PerformAction<'info> {
    #[account(mut)]
    staker: Signer<'info>, 

    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8,
        seeds = [
            b"stake_pool".as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    current_staking_pool: Account<'info, StakePool>,

    #[account(
        init_if_needed,
        payer = staker, 
        space = 8 + 32 + 8 + 8 + 1,
        seeds = [
            b"pool_action".as_ref(),
            staker.key().as_ref()
        ],
        bump
    )]
    pool_action: Account<'info, PoolAction>,


    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8 + 1 + 8,
        seeds = [
            b"pool_entry".as_ref(),
            staker.key().as_ref(),
            &[count]
        ],
        bump
    )]
    pool_entry: Account<'info, PoolActionEntry>,

    #[account(
        init_if_needed,
        payer = staker, 
        space = 8 + 4,
        seeds = [
            b"pool_count".as_ref(),
            staker.key().as_ref()
        ],
        bump
    )]
    pool_count: Account<'info, Count>,

    #[account(
        init_if_needed,
        payer = staker,
        associated_token::mint = token_mint,
        associated_token::authority = current_staking_pool,
    )]
    staking_vault_associated_address: Box<Account<'info, TokenAccount>>,

    #[account(
         mut,
        constraint= staker_associated_address.owner == staker.key(),
        constraint= staker_associated_address.mint == token_mint.key(),
    )]
    staker_associated_address: Box<Account<'info, TokenAccount>>,

    token_mint: Account<'info, Mint>,

    associated_token_program: Program<'info, AssociatedToken>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>
}

#[account]
#[derive(Default)]
pub struct StakePool {
    token_mint: Pubkey,
    token_amount: u64
}

#[account]
#[derive(Default)]
pub struct PoolAction{
    staker: Pubkey,
    token_amount: u64,
    start_time: u64,
}

#[account]
#[derive(Default)]
pub struct PoolActionEntry{
    staker: Pubkey,
    token_amount: u64,
    stake_action: bool,
    time_stamp: i64
}

#[account]
#[derive(Default)]
pub struct Count{
    count: u8,
}

#[error_code]
pub enum ErrorCode {

    #[msg("Not Enough Token")]
    NotEnoughToken,

    #[msg("Not Valid Token")]
    InvalidToken, 

    #[msg("Not Valid User")]
    InvalidUser, 

    #[msg("Not Valid Pool Action Acccount Provided")]
    InvalidPoolAction, 
}