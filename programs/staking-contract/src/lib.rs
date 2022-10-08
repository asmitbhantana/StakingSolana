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
       let clock = Clock::get()?;
       let current_time = clock.unix_timestamp;

       let current_interest = ctx.accounts.token_interest.interest.clone() as u64;
       let current_user = ctx.accounts.staker.clone();
       let token_program = ctx.accounts.token_mint.clone();
              
       let staking_pool = &mut ctx.accounts.current_staking_pool;
       let pool_action = &mut ctx.accounts.pool_action;
       let locked_pool_action = &mut ctx.accounts.lock_pool_action;
        let withdraw_pool_action = &mut ctx.accounts.withdraw_pool_action;

       let pool_action_entry = &mut ctx.accounts.pool_entry;
       let pool_count = &mut ctx.accounts.pool_count;

       require!(token_program.key() == action_token, ErrorCode::InvalidToken);  
        
        //Update the Unlocked token
        let locked_amounts =  locked_pool_action.locked_amount.clone();
        let locked_start_times =  locked_pool_action.locked_start_time.clone();
        let total_length = locked_amounts.len();

       //Stake Action
       if stake_action {

        // Update Pool Action
        pool_action.token_amount += action_amount;

        //Transfer Funds
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

        //Update Staking Pool
        staking_pool.token_amount += action_amount;
        
        let mut pool_updated = false;

        for n in 0..total_length {
            if locked_amounts[n] == locked_start_times[n] as u64 && locked_start_times[n] == 0{
                //Update lock pool action
                locked_pool_action.locked_amount[n] = action_amount;
                locked_pool_action.locked_start_time[n] = current_time;
                pool_updated = true;
                break;
            }
        }
        if !pool_updated{
            locked_pool_action.locked_amount.push(action_amount);
            locked_pool_action.locked_start_time.push(current_time);
        }

        //Update Pool Action Entry 
        pool_action_entry.confirmed = true;

       }

       //Withdraw Action/ Unstake Action
       else {

        //Handle Withdraw Request
        // Queue their withdraw to next sunday
        // Withdraw request can only be made from Monday to Friday 
        let day_of_week = (current_time/86400 + 4)%7;
        require!(day_of_week != 1, ErrorCode::InvalidWithdrawDay);

        //withdraw action amount update
        let withdraw_action_amount = withdraw_pool_action.requested_amount + action_amount;

        for n in 0..total_length {
            ////TODO::Uncomment on production
            // if locked_start_times[n] + 1296000 < current_time {
                let interest_amount = (current_time -  locked_pool_action.locked_start_time[n]) as u64 * (((current_interest/31536000)*locked_pool_action.locked_amount[n] as u64)/100) as u64;
                withdraw_pool_action.requested_amount += locked_pool_action.locked_amount[n] + interest_amount;
                
                if withdraw_pool_action.requested_amount > withdraw_action_amount{
                    locked_pool_action.locked_amount[n] = withdraw_pool_action.requested_amount - withdraw_action_amount;
                    withdraw_pool_action.requested_amount = withdraw_action_amount;
                }
                else{
                    locked_pool_action.locked_start_time[n] = 0;
                    locked_pool_action.locked_amount[n] = 0;
                }
            // }
        }
        //Check Unlocked Amount i.e. exceeded 15 days Locking
        require!(withdraw_pool_action.requested_amount >= action_amount, ErrorCode::LockingPeriod);

       
        require!(staking_pool.token_amount >= action_amount, ErrorCode::NotEnoughToken);
        pool_action.token_amount -= action_amount;

        //Update Withdraw Pool Time
        withdraw_pool_action.requested_time = current_time;
        
        //Update Staking Pool
        staking_pool.token_amount -= action_amount;

        //Update Pool Action Entry 
        pool_action_entry.confirmed = false;
        
       }

        // Update Action Pool 
        if pool_action.start_time == 0{
            pool_action.start_time = current_time; //Set the start time for the first time 
            pool_action.update_time = current_time; //Set the update time to current time
        
        }
        else{
            pool_action.update_time = current_time; //Set the update time to current time
        }

        // Update Pool Entry
        pool_action_entry.stake_action = stake_action;
        pool_action_entry.staker = current_user.key();
        pool_action_entry.token_amount = action_amount;
        pool_action_entry.time_stamp = current_time;
        

        
        pool_count.count = count;

       Ok(())
    }
   

    pub fn claim_withdraw(
        ctx: Context<PerformWithdraw>,
        claim_amount: u64, 
        count: u8
    ) -> Result<()>{
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        let current_user = ctx.accounts.staker.clone();
        let token_program = ctx.accounts.token_mint.clone();

        let withdraw_pool_action = &mut ctx.accounts.withdraw_pool_action;
        let pool_action_entry = &mut ctx.accounts.pool_entry;
        let pool_count = &mut ctx.accounts.pool_count;


        let token_mint_key = ctx.accounts.token_mint.clone().key();
        let current_staking_pool_account = ctx.accounts.current_staking_pool.clone().to_account_info();

        require!(ctx.accounts.current_staking_pool.token_amount >= claim_amount, ErrorCode::ExceedPoolAmount );

        let day_of_week = (current_time/86400 + 4)%7;
        //TODO::Uncomment on production
        // require!(day_of_week == 1, ErrorCode::InvalidWithdrawDay);

        //Transfer Funds
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
        anchor_spl::token::transfer(cpi_ctx, claim_amount)?;
        
        withdraw_pool_action.requested_amount -= claim_amount;

        // Update Pool Entry
        pool_action_entry.stake_action = false;
        pool_action_entry.staker = current_user.key();
        pool_action_entry.token_amount = claim_amount;
        pool_action_entry.time_stamp = current_time;
        pool_action_entry.confirmed = true;

        pool_count.count = count;

        Ok(())
    }

    pub fn update_admin_wallet(
        ctx: Context<UpdateConfig>,
        new_admin: Pubkey
    ) -> Result<()> {
        let current_admin = ctx.accounts.admin_config.admin;
        if current_admin == Pubkey::new(&[0; 32]) || ctx.accounts.owner.key() == current_admin{
            let updated_config = &mut ctx.accounts.admin_config;
            updated_config.admin = new_admin;   
        }
        else{
           return err!(ErrorCode::InvalidAdmin);
        }

        Ok(())
    }

    pub fn update_interest_rate(
        ctx: Context<UpdateInterest>, 
        new_interest: u8
    ) -> Result<()> {
        require!(ctx.accounts.admin.key() == ctx.accounts.admin_config.admin.key(), ErrorCode::InvalidAdmin);
        
        let interest_rate = &mut ctx.accounts.token_interest;
        interest_rate.interest = new_interest;

        Ok(())
    }
    
    //Rescue any token by the owner
    pub fn rescuse_token(
        ctx: Context<WithdrawToken>,
        withdraw_amount: u64
    ) -> Result<()>{

        let token_mint_key = ctx.accounts.token_mint.clone().key();
        let current_staking_pool_account = ctx.accounts.current_staking_pool.clone().to_account_info();
       let staking_pool = &mut ctx.accounts.current_staking_pool;

        require!(staking_pool.token_amount >= withdraw_amount, ErrorCode::ExceedPoolAmount );

         //Transfer Funds
        let bump_seed_staking_pool = ctx.bumps.get("current_staking_pool").unwrap().to_le_bytes();
        let staking_pool_signer_seeds: &[&[_]] = &[
            b"stake_pool".as_ref(),
            &token_mint_key.as_ref(),
            &bump_seed_staking_pool
        ];

        let transfer_instruction = Transfer{
            from: ctx.accounts.staking_vault_associated_address.to_account_info(),
            to: ctx.accounts.admin_associated_address.to_account_info(),
            authority: current_staking_pool_account.clone(),
        };

        let signer = &[staking_pool_signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
            signer,
        );
        anchor_spl::token::transfer(cpi_ctx, withdraw_amount)?;
        staking_pool.token_amount -= withdraw_amount;

        Ok(())
    }

   

    
    //Deposit any token by the owner
    pub fn deposit_token(
        ctx: Context<DepositToken>,
        deposit_amount: u64
    ) -> Result<()>{
       let staking_pool = &mut ctx.accounts.current_staking_pool;

        //Transfer Funds
        let transfer_instruction = Transfer{
            from: ctx.accounts.admin_associated_address.to_account_info(),
            to: ctx.accounts.staking_vault_associated_address.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
        );
        anchor_spl::token::transfer(cpi_ctx, deposit_amount)?;

        staking_pool.token_amount += deposit_amount;

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
        space = 8 + 8 + 8 + 8,
        seeds = [
            b"pool_action".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    pool_action: Account<'info, PoolAction>,

    #[account(
        init_if_needed,
        payer = staker, 
        space = 8 + 4 + 8*2*10, //8*2*10
        seeds = [
            b"lock_pool_action".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    lock_pool_action: Account<'info, LockedPool>,

    
    #[account(
        init_if_needed,
        payer = staker, 
        space = 8 + 8 + 8,
        seeds = [
            b"withdraw_pool_action".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    withdraw_pool_action: Account<'info, WithdrawRequest>,

    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8 + 1 + 8 + 1,
        seeds = [
            b"pool_entry".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref(),
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
            staker.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    pool_count: Account<'info, Count>,

    #[account(
        init_if_needed, 
        payer = staker, 
        space = 8 + 8, 
        seeds = [
            b"token_interest".as_ref(), 
            token_mint.key().as_ref()
        ], 
        bump
    )]
    token_interest: Account<'info, InterestRate>, 

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

#[derive(Accounts)]
pub struct UpdateInterest<'info> {
    #[account(mut)]
    admin: Signer<'info>,

    #[account(
        init_if_needed, 
        payer = admin, 
        space = 8 + 8, 
        seeds = [
            b"token_interest".as_ref(), 
            token_mint.key().as_ref()
        ], 
        bump
    )]
    token_interest: Account<'info, InterestRate>, 


    #[account(
        mut,
        owner = program_id.clone(),
        seeds= [
            b"admin_config".as_ref(),
        ],
        bump,
    )]
    admin_config: Account<'info, Config>,

    token_mint: Account<'info, Mint>,
    associated_token_program: Program<'info, AssociatedToken>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>

}

#[derive(Accounts)]
#[instruction(claim_amount: u64, count: u8)]
pub struct PerformWithdraw<'info>{
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
        space = 8 + 8 + 8,
        seeds = [
            b"withdraw_pool_action".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    withdraw_pool_action: Account<'info, WithdrawRequest>,

    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8 + 1 + 8 + 1,
        seeds = [
            b"pool_entry".as_ref(),
            staker.key().as_ref(),
            token_mint.key().as_ref(),
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
            staker.key().as_ref(),
            token_mint.key().as_ref()
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
#[derive(Accounts)]
pub struct UpdateConfig<'info>{
    
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        owner = program_id.clone(),
        payer = owner,
        seeds= [
            b"admin_config".as_ref(),
        ],
        bump,
        space = 8 + 32
    )]
    pub admin_config: Account<'info, Config>,
    
    // Application level accounts 
    system_program: Program<'info, System>,
    rent: Sysvar<'info, Rent>,

}

#[derive(Accounts)]
#[instruction(withdraw_amount: u64)]
pub struct WithdrawToken<'info>{
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
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
        owner = program_id.clone(),
        payer = owner,
        seeds= [
            b"admin_config".as_ref(),
        ],
        bump,
        space = 8 + 32
    )]
    pub admin_config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = token_mint,
        associated_token::authority = current_staking_pool,
    )]
    staking_vault_associated_address: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint= admin_associated_address.owner == owner.key(),
        constraint= admin_associated_address.mint == token_mint.key(),
    )]
    admin_associated_address: Box<Account<'info, TokenAccount>>,

    token_mint: Account<'info, Mint>,

    associated_token_program: Program<'info, AssociatedToken>,
    
    // Application level accounts 
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(withdraw_amount: u64)]
pub struct DepositToken<'info>{
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
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
        owner = program_id.clone(),
        payer = owner,
        seeds= [
            b"admin_config".as_ref(),
        ],
        bump,
        space = 8 + 32
    )]
    pub admin_config: Account<'info, Config>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = token_mint,
        associated_token::authority = current_staking_pool,
    )]
    staking_vault_associated_address: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint= admin_associated_address.owner == owner.key(),
        constraint= admin_associated_address.mint == token_mint.key(),
    )]
    admin_associated_address: Box<Account<'info, TokenAccount>>,

    token_mint: Account<'info, Mint>,

    associated_token_program: Program<'info, AssociatedToken>,
    
    // Application level accounts 
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>,
}

#[account]
#[derive(Default)]
pub struct Config{
    admin: Pubkey
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
    token_amount: u64,
    start_time: i64,
    update_time: i64,
}

#[account]
#[derive(Default)]
pub struct LockedPool{
    locked_amount: Vec<u64>,  // 100000
    locked_start_time: Vec<i64> // 23456666
}

#[account]
#[derive(Default)]
pub struct PoolActionEntry{
    staker: Pubkey,
    token_amount: u64,
    stake_action: bool,
    time_stamp: i64, 
    confirmed: bool,
}

#[account]
#[derive(Default)]
pub struct WithdrawRequest{
    requested_amount: u64,
    requested_time: i64,
}

#[account]
#[derive(Default)]
pub struct InterestRate{
    interest: u8,
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

    #[msg("Not Valid Pool Action Account Provided")]
    InvalidPoolAction, 

    #[msg("Insufficient Amount for Withdraw! Wait for 15days unlocking Period!")]
    LockingPeriod,

    #[msg("Cannot request other than on Sunday")]
    InvalidWithdrawDay,

    #[msg("Invalid Admin")]
    InvalidAdmin,

    #[msg("Amount Exceeds Pool Amount")]
    ExceedPoolAmount,


}